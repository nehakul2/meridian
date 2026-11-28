//! The four trade paths on one book (MER-20, MER-22, MER-23, MER-24, MER-25).
//!
//! - `place_order`: Buy Yes (BID) and Sell Yes (ASK); GTC, IOC (market order with a
//!   mandatory worst price, D21) and POST_ONLY.
//! - `buy_no_market`: mint exactly the fillable quantity and sell that Yes into bids.
//! - `buy_no_limit`: mint, then rest the Yes as an ask tagged BUY_NO.
//! - `sell_no`: buy Yes up to a worst price and merge it with the user's No.
//!
//! All four share one account list (`Trade`) and the same guards: not paused, market
//! TRADING, and `open_time <= now < close_time` by the chain clock (D12 halt at close).
//! Makers' `UserLedger`s are passed as remaining accounts (writable), in any order.
//!
//! Taker fee (MER-25): `fee_bps` of each fill's notional, rounded up, paid in USDC by the
//! taker on top of a buy or out of a sale's proceeds. It accrues in the market's quote
//! vault (`OrderBook.fees_accrued`) and `sweep_fees` moves it to `Config.fee_vault`. It
//! never touches the collateral vault.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::book::{self, match_taker, Balances, LedgerVec, MatchOutcome};
use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::*;
use crate::instructions::market::ticker_seed;
use crate::instructions::token_ops::*;
use crate::invariants::{assert_book_escrow, assert_invariants, MarketSnapshot};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = market.ticker_day @ MeridianError::AccountMismatch)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.book @ MeridianError::AccountMismatch)]
    pub book: AccountLoader<'info, OrderBook>,

    /// Yes escrow; checked against `book.base_vault` in the handler.
    #[account(mut)]
    pub base_vault: Box<Account<'info, TokenAccount>>,

    /// USDC escrow; checked against `book.quote_vault` in the handler.
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// The taker's ledger: created on first use (MER-21); holds resting locks.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserLedger::INIT_SPACE,
        seeds = [LEDGER_SEED, market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub ledger: Box<Account<'info, UserLedger>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn side_index(s: Side) -> usize {
    match s {
        Side::Bid => SIDE_BID,
        Side::Ask => SIDE_ASK,
    }
}
pub fn side_of(i: usize) -> Side {
    if i == SIDE_BID {
        Side::Bid
    } else {
        Side::Ask
    }
}
pub fn tag_of(t: u8) -> OrderTag {
    if t == ORDER_TAG_BUY_NO {
        OrderTag::BuyNo
    } else {
        OrderTag::None
    }
}

/// Entry guards shared by every trade path (D12, D26, D30).
pub fn check_can_trade(config: &Config, market: &Market, td: &TickerDay, now: i64) -> Result<()> {
    require!(!config.paused, MeridianError::Paused);
    require!(
        market.status == MarketStatus::Trading,
        MeridianError::MarketNotTrading
    );
    require!(now >= td.open_time, MeridianError::MarketNotOpen);
    require!(now < td.close_time, MeridianError::MarketHalted);
    Ok(())
}

fn check_order(price: u8, qty: u64) -> Result<()> {
    require!(book::valid_price(price), MeridianError::InvalidPrice);
    require!(qty > 0, MeridianError::ZeroQuantity);
    require!(qty <= MAX_ORDER_QTY, MeridianError::OrderTooLarge);
    Ok(())
}

/// Loads makers' ledgers from the remaining accounts: program-owned, writable,
/// `UserLedger` discriminator, same market. Anything else is ignored.
pub fn load_maker_ledgers<'info>(
    remaining: &'info [AccountInfo<'info>],
    market: &Pubkey,
    own_ledger: &Pubkey,
) -> Vec<Account<'info, UserLedger>> {
    let mut out: Vec<Account<'info, UserLedger>> = Vec::with_capacity(remaining.len());
    for info in remaining {
        if !info.is_writable
            || info.owner != &crate::ID
            || info.key == own_ledger
            || out.iter().any(|a| a.key() == *info.key)
        {
            continue;
        }
        if let Ok(acc) = Account::<UserLedger>::try_from(info) {
            if acc.market == *market {
                out.push(acc);
            }
        }
    }
    out
}

/// Result of matching, before the caller's token movements.
struct Matched<'info> {
    out: MatchOutcome,
    order_id: u64,
    rested: u64,
    makers: Vec<Account<'info, UserLedger>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rest {
    /// IOC: drop the remainder.
    No,
    /// GTC: rest the remainder.
    Yes,
}

/// Initialises the taker ledger, matches, optionally rests the remainder, and writes all
/// ledger balances back. Token movements are the caller's job.
#[allow(clippy::too_many_arguments)]
fn run_match<'info>(
    a: &mut Trade<'info>,
    ledger_bump: u8,
    remaining: &'info [AccountInfo<'info>],
    side: usize,
    price: u8,
    qty: u64,
    rest: Rest,
    post_only: bool,
    tag: u8,
    alloc_id: bool,
) -> Result<Matched<'info>> {
    let user = a.user.key();
    let market_key = a.market.key();
    if a.ledger.owner == Pubkey::default() {
        a.ledger.market = market_key;
        a.ledger.owner = user;
        a.ledger.bump = ledger_bump;
    }
    let mut makers = load_maker_ledgers(remaining, &market_key, &a.ledger.key());
    let mut set = LedgerVec {
        owners: Vec::with_capacity(makers.len() + 1),
        bals: Vec::with_capacity(makers.len() + 1),
    };
    set.owners.push(user);
    set.bals.push(Balances::of(&a.ledger));
    for m in &makers {
        set.owners.push(m.owner);
        set.bals.push(Balances::of(m));
    }

    let mut bk = a.book.load_mut()?;
    require_keys_eq!(
        bk.base_vault,
        a.base_vault.key(),
        MeridianError::AccountMismatch
    );
    require_keys_eq!(
        bk.quote_vault,
        a.quote_vault.key(),
        MeridianError::AccountMismatch
    );
    if post_only {
        require!(!bk.crosses(side, price), MeridianError::WouldCross);
    }
    let order_id = if alloc_id { bk.alloc_order_id()? } else { 0 };
    let out = if post_only {
        MatchOutcome::default()
    } else {
        match_taker(&mut bk, &user, side, price, qty, a.config.fee_bps, &mut set)?
    };
    // Taker fees accrue in this market's quote vault; sweep_fees moves them to
    // Config.fee_vault. Keeping the shared fee vault out of trades means trades on
    // different markets never write the same account (CON-09, R6.1).
    bk.fees_accrued = bk
        .fees_accrued
        .checked_add(out.fees)
        .ok_or(MeridianError::Overflow)?;
    let left = qty - out.filled;
    let mut rested = 0;
    if left > 0 && rest == Rest::Yes {
        // Only possible after matching stopped at a missing maker ledger or the fill cap.
        require!(
            !bk.crosses(side, price),
            if out.capped {
                MeridianError::FillLimitReached
            } else {
                MeridianError::MakerLedgerMissing
            }
        );
        let o = BookOrder {
            owner: user,
            order_id,
            qty: left,
            tag,
            _pad: [0; 7],
        };
        bk.rest(side, price, o, &mut set.bals[0])?;
        rested = left;
    }
    drop(bk);

    set.bals[0].store(&mut a.ledger);
    for (i, m) in makers.iter_mut().enumerate() {
        set.bals[i + 1].store(m);
    }
    a.market.total_trades = a
        .market
        .total_trades
        .checked_add(out.fills.len() as u64)
        .ok_or(MeridianError::Overflow)?;
    Ok(Matched {
        out,
        order_id,
        rested,
        makers,
    })
}

/// Persists maker ledgers and emits fill and self-trade events.
fn finish_match<'info>(
    a: &mut Trade<'info>,
    em: &mut Emitter<'info>,
    m: &Matched<'info>,
    side: usize,
) -> Result<()> {
    for acc in &m.makers {
        acc.exit(&crate::ID)?;
    }
    let slot = Clock::get()?.slot;
    let market = a.market.key();
    let taker = a.user.key();
    for f in &m.out.fills {
        let seq = a.market.next_seq()?;
        em.emit(&Fill {
            market,
            slot,
            seq,
            maker_order_id: f.maker_order_id,
            maker: f.maker,
            taker,
            side: side_of(side),
            price: f.price,
            qty: f.qty,
            taker_fee: f.fee,
        })?;
    }
    for c in &m.out.self_cancels {
        let seq = a.market.next_seq()?;
        em.emit(&OrderCancelled {
            market,
            slot,
            seq,
            order_id: c.order.order_id,
            owner: taker,
            side: side_of(c.side),
            price: c.price,
            qty: c.order.qty,
            reason: CancelReason::SelfTrade,
        })?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_placed<'info>(
    a: &mut Trade<'info>,
    em: &mut Emitter<'info>,
    m: &Matched,
    side: usize,
    price: u8,
    tif: TimeInForce,
    tag: OrderTag,
    client_id: u64,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let seq = a.market.next_seq()?;
    em.emit(&OrderPlaced {
        market: a.market.key(),
        slot,
        seq,
        order_id: m.order_id,
        owner: a.user.key(),
        side: side_of(side),
        price,
        qty: m.rested,
        tif,
        tag,
        client_id,
    })
}

fn emit_pair<'info>(
    a: &mut Trade<'info>,
    em: &mut Emitter<'info>,
    n: u64,
    via: Via,
    minted: bool,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let seq = a.market.next_seq()?;
    let (market, owner) = (a.market.key(), a.user.key());
    if minted {
        em.emit(&PairMinted {
            market,
            slot,
            seq,
            owner,
            n,
            via,
        })
    } else {
        em.emit(&PairMerged {
            market,
            slot,
            seq,
            owner,
            n,
            via,
        })
    }
}

/// Book escrow (spec 4.3 #7) and, where supply or collateral moved, the market invariants.
fn check_all(a: &mut Trade, market_too: bool) -> Result<()> {
    a.base_vault.reload()?;
    a.quote_vault.reload()?;
    {
        let bk = a.book.load()?;
        assert_book_escrow(a.base_vault.amount, a.quote_vault.amount, &bk)?;
    }
    if market_too {
        a.vault.reload()?;
        a.yes_mint.reload()?;
        a.no_mint.reload()?;
        assert_invariants(&MarketSnapshot::of(
            &a.market,
            a.vault.amount,
            a.yes_mint.supply,
            a.no_mint.supply,
        ))?;
    }
    Ok(())
}

fn need(have: u64, want: u64, e: MeridianError) -> Result<()> {
    if have < want {
        return Err(e.into());
    }
    Ok(())
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(MeridianError::Overflow))
}

/// MER-20: Buy Yes / Sell Yes.
pub fn place_order<'info>(
    ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
    side: Side,
    price: u8,
    qty: u64,
    tif: TimeInForce,
    client_id: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.event_authority;
    let ledger_bump = ctx.bumps.ledger;
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    check_can_trade(&a.config, &a.market, &a.ticker_day, now)?;
    check_order(price, qty)?;
    let s = side_index(side);
    let rest = if tif == TimeInForce::Ioc {
        Rest::No
    } else {
        Rest::Yes
    };
    let m = run_match(
        a,
        ledger_bump,
        remaining,
        s,
        price,
        qty,
        rest,
        tif == TimeInForce::PostOnly,
        ORDER_TAG_NONE,
        true,
    )?;
    let o = &m.out;
    let tp = a.token_program.to_account_info();
    let signer = MarketSigner::new(&a.market);
    let mkt = a.market.to_account_info();
    let user = a.user.to_account_info();
    if s == SIDE_BID {
        let lock = book::notional(price, m.rested)?;
        let pay = add(add(o.notional, lock)?, o.fees)?;
        need(a.user_usdc.amount, pay, MeridianError::InsufficientFunds)?;
        transfer(
            &tp,
            &a.user_usdc.to_account_info(),
            &a.quote_vault.to_account_info(),
            &user,
            None,
            add(o.notional, lock)?,
        )?;
        transfer(
            &tp,
            &a.user_usdc.to_account_info(),
            &a.quote_vault.to_account_info(),
            &user,
            None,
            o.fees,
        )?;
        transfer(
            &tp,
            &a.base_vault.to_account_info(),
            &a.user_yes.to_account_info(),
            &mkt,
            Some(&signer),
            o.filled,
        )?;
    } else {
        let deliver = add(o.filled, m.rested)?;
        need(
            a.user_yes.amount,
            deliver,
            MeridianError::InsufficientTokens,
        )?;
        transfer(
            &tp,
            &a.user_yes.to_account_info(),
            &a.base_vault.to_account_info(),
            &user,
            None,
            deliver,
        )?;
        let net = o.notional - o.fees;
        transfer(
            &tp,
            &a.quote_vault.to_account_info(),
            &a.user_usdc.to_account_info(),
            &mkt,
            Some(&signer),
            net,
        )?;
    }
    finish_match(a, &mut em, &m, s)?;
    if m.rested > 0 {
        emit_placed(a, &mut em, &m, s, price, tif, OrderTag::None, client_id)?;
    } else if qty > o.filled {
        // IOC remainder (or a remainder dropped because nothing rests): reported, not kept.
        let slot = Clock::get()?.slot;
        let seq = a.market.next_seq()?;
        em.emit(&OrderCancelled {
            market: a.market.key(),
            slot,
            seq,
            order_id: m.order_id,
            owner: a.user.key(),
            side,
            price,
            qty: qty - o.filled,
            reason: CancelReason::IocRemainder,
        })?;
    }
    check_all(a, false)
}

/// MER-22: Buy No at market. Sells Yes into bids at `min_yes_price` or better, minting
/// exactly the filled quantity `f`; the user keeps `f` No and never holds unsold Yes.
pub fn buy_no_market<'info>(
    ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
    qty: u64,
    min_yes_price: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.event_authority;
    let ledger_bump = ctx.bumps.ledger;
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    check_can_trade(&a.config, &a.market, &a.ticker_day, now)?;
    check_order(min_yes_price, qty)?;
    let m = run_match(
        a,
        ledger_bump,
        remaining,
        SIDE_ASK,
        min_yes_price,
        qty,
        Rest::No,
        false,
        ORDER_TAG_NONE,
        false,
    )?;
    let o = &m.out;
    let f = o.filled;
    require!(f > 0, MeridianError::NoLiquidity);
    let collateral = f
        .checked_mul(MICRO_USDC_PER_PAIR)
        .ok_or(MeridianError::Overflow)?;
    // Bids' locked USDC becomes collateral; the user pays the rest: f x (1 - p) + fees.
    let from_user = collateral - o.notional;
    need(
        a.user_usdc.amount,
        add(from_user, o.fees)?,
        MeridianError::InsufficientFunds,
    )?;

    let tp = a.token_program.to_account_info();
    let signer = MarketSigner::new(&a.market);
    let mkt = a.market.to_account_info();
    let user = a.user.to_account_info();
    transfer(
        &tp,
        &a.quote_vault.to_account_info(),
        &a.vault.to_account_info(),
        &mkt,
        Some(&signer),
        o.notional,
    )?;
    transfer(
        &tp,
        &a.user_usdc.to_account_info(),
        &a.vault.to_account_info(),
        &user,
        None,
        from_user,
    )?;
    transfer(
        &tp,
        &a.user_usdc.to_account_info(),
        &a.quote_vault.to_account_info(),
        &user,
        None,
        o.fees,
    )?;
    mint_to(
        &tp,
        &a.yes_mint.to_account_info(),
        &a.base_vault.to_account_info(),
        &mkt,
        &signer,
        f,
    )?;
    mint_to(
        &tp,
        &a.no_mint.to_account_info(),
        &a.user_no.to_account_info(),
        &mkt,
        &signer,
        f,
    )?;

    let mk = &mut a.market;
    mk.pairs_outstanding = add(mk.pairs_outstanding, f)?;
    mk.collateral_accounted = add(mk.collateral_accounted, collateral)?;
    mk.total_minted = add(mk.total_minted, f)?;

    emit_pair(a, &mut em, f, Via::BuyNo, true)?;
    finish_match(a, &mut em, &m, SIDE_ASK)?;
    check_all(a, true)
}

/// MER-23: Buy No limit. Mints `qty` pairs and offers the Yes at `yes_price` (GTC),
/// tagged BUY_NO. Any part that crosses existing bids fills at once.
pub fn buy_no_limit<'info>(
    ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
    qty: u64,
    yes_price: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.event_authority;
    let ledger_bump = ctx.bumps.ledger;
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    check_can_trade(&a.config, &a.market, &a.ticker_day, now)?;
    check_order(yes_price, qty)?;
    let collateral = qty
        .checked_mul(MICRO_USDC_PER_PAIR)
        .ok_or(MeridianError::Overflow)?;
    need(
        a.user_usdc.amount,
        collateral,
        MeridianError::InsufficientFunds,
    )?;

    let m = run_match(
        a,
        ledger_bump,
        remaining,
        SIDE_ASK,
        yes_price,
        qty,
        Rest::Yes,
        false,
        ORDER_TAG_BUY_NO,
        true,
    )?;
    let o = &m.out;
    let tp = a.token_program.to_account_info();
    let signer = MarketSigner::new(&a.market);
    let mkt = a.market.to_account_info();
    let user = a.user.to_account_info();
    transfer(
        &tp,
        &a.user_usdc.to_account_info(),
        &a.vault.to_account_info(),
        &user,
        None,
        collateral,
    )?;
    // All qty Yes go to the book: the filled part is credited to makers, the rest rests.
    mint_to(
        &tp,
        &a.yes_mint.to_account_info(),
        &a.base_vault.to_account_info(),
        &mkt,
        &signer,
        qty,
    )?;
    mint_to(
        &tp,
        &a.no_mint.to_account_info(),
        &a.user_no.to_account_info(),
        &mkt,
        &signer,
        qty,
    )?;
    transfer(
        &tp,
        &a.quote_vault.to_account_info(),
        &a.user_usdc.to_account_info(),
        &mkt,
        Some(&signer),
        o.notional - o.fees,
    )?;

    let mk = &mut a.market;
    mk.pairs_outstanding = add(mk.pairs_outstanding, qty)?;
    mk.collateral_accounted = add(mk.collateral_accounted, collateral)?;
    mk.total_minted = add(mk.total_minted, qty)?;

    emit_pair(a, &mut em, qty, Via::BuyNo, true)?;
    finish_match(a, &mut em, &m, SIDE_ASK)?;
    if m.rested > 0 {
        emit_placed(
            a,
            &mut em,
            &m,
            SIDE_ASK,
            yes_price,
            TimeInForce::Gtc,
            OrderTag::BuyNo,
            0,
        )?;
        // Let the Market PDA burn the No that pairs with the resting Yes, so a
        // permissionless prune after close can convert both to USDC (D15, MER-35).
        // Set to all of this user's unfilled BUY_NO quantity in the market.
        approve(
            &tp,
            &a.user_no.to_account_info(),
            &a.market.to_account_info(),
            &a.user.to_account_info(),
            a.ledger.pending_buy_no,
        )?;
    }
    check_all(a, true)
}

/// MER-24: Sell No. Buys up to `qty` Yes at `max_yes_price` or better (IOC) and merges
/// the filled quantity with the user's No; the user receives `f x $1 - cost`.
pub fn sell_no<'info>(
    ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
    qty: u64,
    max_yes_price: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.event_authority;
    let ledger_bump = ctx.bumps.ledger;
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    check_can_trade(&a.config, &a.market, &a.ticker_day, now)?;
    check_order(max_yes_price, qty)?;
    need(a.user_no.amount, qty, MeridianError::InsufficientTokens)?;
    let m = run_match(
        a,
        ledger_bump,
        remaining,
        SIDE_BID,
        max_yes_price,
        qty,
        Rest::No,
        false,
        ORDER_TAG_NONE,
        false,
    )?;
    let o = &m.out;
    let f = o.filled;
    if f > 0 {
        let collateral = f
            .checked_mul(MICRO_USDC_PER_PAIR)
            .ok_or(MeridianError::Overflow)?;
        let tp = a.token_program.to_account_info();
        let signer = MarketSigner::new(&a.market);
        let mkt = a.market.to_account_info();
        let user = a.user.to_account_info();
        // $1 per merged pair first, then the user pays the Yes cost and fees from it.
        transfer(
            &tp,
            &a.vault.to_account_info(),
            &a.user_usdc.to_account_info(),
            &mkt,
            Some(&signer),
            collateral,
        )?;
        a.user_usdc.reload()?;
        need(
            a.user_usdc.amount,
            add(o.notional, o.fees)?,
            MeridianError::InsufficientFunds,
        )?;
        transfer(
            &tp,
            &a.user_usdc.to_account_info(),
            &a.quote_vault.to_account_info(),
            &user,
            None,
            o.notional,
        )?;
        transfer(
            &tp,
            &a.user_usdc.to_account_info(),
            &a.quote_vault.to_account_info(),
            &user,
            None,
            o.fees,
        )?;
        burn(
            &tp,
            &a.yes_mint.to_account_info(),
            &a.base_vault.to_account_info(),
            &mkt,
            Some(&signer),
            f,
        )?;
        burn(
            &tp,
            &a.no_mint.to_account_info(),
            &a.user_no.to_account_info(),
            &user,
            None,
            f,
        )?;
        let mk = &mut a.market;
        mk.pairs_outstanding = mk
            .pairs_outstanding
            .checked_sub(f)
            .ok_or(MeridianError::InvariantViolated)?;
        mk.collateral_accounted = mk
            .collateral_accounted
            .checked_sub(collateral)
            .ok_or(MeridianError::InvariantViolated)?;
    }
    finish_match(a, &mut em, &m, SIDE_BID)?;
    if f > 0 {
        emit_pair(a, &mut em, f, Via::SellNo, false)?;
    }
    check_all(a, true)
}
