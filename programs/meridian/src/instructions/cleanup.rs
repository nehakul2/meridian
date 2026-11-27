//! Post-close cleanup (MER-35): prune_orders and close_book (D12, D15, D29).
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::book::{Balances, LedgerSet, LedgerVec};
use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::*;
use crate::instructions::market::ticker_seed;
use crate::instructions::token_ops::*;
use crate::instructions::trade::{load_maker_ledgers, side_of};
use crate::invariants::{assert_book_escrow, assert_invariants, MarketSnapshot};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
pub struct PruneOrders<'info> {
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

    /// Checked against `book.base_vault`.
    #[account(mut)]
    pub base_vault: Box<Account<'info, TokenAccount>>,

    /// Checked against `book.quote_vault`.
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

/// An owner's No token account found in the remaining accounts, with how much of it the
/// Market PDA may still burn (min of balance and delegated allowance).
struct NoAccount<'info> {
    info: AccountInfo<'info>,
    owner: Pubkey,
    burnable: u64,
    burned: u64,
}

fn load_no_accounts<'info>(
    remaining: &'info [AccountInfo<'info>],
    no_mint: &Pubkey,
    market: &Pubkey,
) -> Vec<NoAccount<'info>> {
    let mut out: Vec<NoAccount<'info>> = vec![];
    for info in remaining {
        if !info.is_writable || info.owner != &anchor_spl::token::ID {
            continue;
        }
        if let Ok(acc) = Account::<TokenAccount>::try_from(info) {
            if acc.mint != *no_mint || out.iter().any(|n| n.owner == acc.owner) {
                continue;
            }
            let allowed = if acc.delegate
                == anchor_lang::solana_program::program_option::COption::Some(*market)
            {
                acc.delegated_amount
            } else {
                0
            };
            out.push(NoAccount {
                info: info.clone(),
                owner: acc.owner,
                burnable: allowed.min(acc.amount),
                burned: 0,
            });
        }
    }
    out
}

/// Permissionless (D12, D30). After `close_time`, or once the market is SETTLED or VOID,
/// cancels up to `max` resting orders, oldest level first (bids then asks, 1 to 99
/// cents), unlocking each remainder to its owner's ledger.
///
/// Remaining accounts: each resting owner's `UserLedger`, and for BUY_NO owners their No
/// token account. Pruning stops at the first order whose ledger is missing, so orders are
/// always pruned in book order. A BUY_NO order converts its unfilled Yes plus the same
/// number of the owner's No into $1.00 USDC per pair in the owner's ledger (D15), using
/// the allowance `buy_no_limit` gave the Market PDA. If the No account is not passed, or
/// holds less No or allowance than needed, the rest is unlocked as free Yes: Yes plus No
/// still redeem for $1.00 together, so no value is lost either way.
pub fn prune_orders<'info>(
    ctx: Context<'_, '_, 'info, 'info, PruneOrders<'info>>,
    max: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ea_bump = ctx.bumps.event_authority;
    let remaining = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), ea_bump);
    require!(
        matches!(a.market.status, MarketStatus::Settled | MarketStatus::Void)
            || now >= a.ticker_day.close_time,
        MeridianError::PruneNotAllowed
    );
    require!(
        max > 0 && max <= MAX_PRUNE_BATCH,
        MeridianError::InvalidConfig
    );
    let market_key = a.market.key();

    let mut ledgers = load_maker_ledgers(remaining, &market_key, &Pubkey::default());
    let mut set = LedgerVec {
        owners: ledgers.iter().map(|l| l.owner).collect(),
        bals: ledgers.iter().map(|l| Balances::of(l)).collect(),
    };
    let mut nos = load_no_accounts(remaining, &a.no_mint.key(), &market_key);

    let mut pruned: Vec<(usize, u8, BookOrder)> = vec![];
    let mut converted: u64 = 0;
    let left;
    {
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
        'scan: for side in [SIDE_BID, SIDE_ASK] {
            for price in MIN_PRICE..=MAX_PRICE {
                while bk.level(side, price).len > 0 {
                    if pruned.len() >= max as usize {
                        break 'scan;
                    }
                    let owner = bk.level(side, price).orders[0].owner;
                    let Some(bal) = set.get(&owner) else {
                        break 'scan;
                    };
                    let o = bk.remove_at(side, price, 0);
                    bk.unlock(side, price, &o, bal)?;
                    if o.tag == ORDER_TAG_BUY_NO && side == SIDE_ASK {
                        if let Some(n) = nos.iter_mut().find(|n| n.owner == owner) {
                            let k = o.qty.min(n.burnable - n.burned);
                            if k > 0 {
                                n.burned += k;
                                converted =
                                    converted.checked_add(k).ok_or(MeridianError::Overflow)?;
                                bk.take_free(bal, 0, k)?;
                                let usdc = k
                                    .checked_mul(MICRO_USDC_PER_PAIR)
                                    .ok_or(MeridianError::Overflow)?;
                                bk.credit_free_usdc(bal, usdc)?;
                            }
                        }
                    }
                    pruned.push((side, price, o));
                }
            }
        }
        left = bk.order_count;
    }
    // Nothing pruned while orders remain means the first owner's ledger was not passed.
    require!(
        !pruned.is_empty() || left == 0,
        MeridianError::MakerLedgerMissing
    );
    for (l, b) in ledgers.iter_mut().zip(set.bals.iter()) {
        b.store(l);
        l.exit(&crate::ID)?;
    }

    if converted > 0 {
        let tp = a.token_program.to_account_info();
        let signer = MarketSigner::new(&a.market);
        let mkt = a.market.to_account_info();
        burn(
            &tp,
            &a.yes_mint.to_account_info(),
            &a.base_vault.to_account_info(),
            &mkt,
            Some(&signer),
            converted,
        )?;
        for n in nos.iter().filter(|n| n.burned > 0) {
            // The Market PDA burns as the delegate approved in buy_no_limit.
            burn(
                &tp,
                &a.no_mint.to_account_info(),
                &n.info,
                &mkt,
                Some(&signer),
                n.burned,
            )?;
        }
        let usdc = converted
            .checked_mul(MICRO_USDC_PER_PAIR)
            .ok_or(MeridianError::Overflow)?;
        transfer(
            &tp,
            &a.vault.to_account_info(),
            &a.quote_vault.to_account_info(),
            &mkt,
            Some(&signer),
            usdc,
        )?;
        let mk = &mut a.market;
        mk.pairs_outstanding = mk
            .pairs_outstanding
            .checked_sub(converted)
            .ok_or(MeridianError::InvariantViolated)?;
        // Burning one Yes and one No removes exactly $1.00 of claims whatever the outcome.
        mk.collateral_accounted = mk
            .collateral_accounted
            .checked_sub(usdc)
            .ok_or(MeridianError::InvariantViolated)?;
    }

    let slot = Clock::get()?.slot;
    for (side, price, o) in &pruned {
        let seq = a.market.next_seq()?;
        em.emit(&OrderCancelled {
            market: market_key,
            slot,
            seq,
            order_id: o.order_id,
            owner: o.owner,
            side: side_of(*side),
            price: *price,
            qty: o.qty,
            reason: CancelReason::Prune,
        })?;
    }
    for n in nos.iter().filter(|n| n.burned > 0) {
        let seq = a.market.next_seq()?;
        em.emit(&PairMerged {
            market: market_key,
            slot,
            seq,
            owner: n.owner,
            n: n.burned,
            via: Via::CancelBuyNo,
        })?;
    }

    a.base_vault.reload()?;
    a.quote_vault.reload()?;
    a.vault.reload()?;
    a.yes_mint.reload()?;
    a.no_mint.reload()?;
    {
        let bk = a.book.load()?;
        assert_book_escrow(a.base_vault.amount, a.quote_vault.amount, &bk)?;
    }
    assert_invariants(&MarketSnapshot::of(
        &a.market,
        a.vault.amount,
        a.yes_mint.supply,
        a.no_mint.supply,
    ))
}

// ---------------------------------------------------------------- close_book

#[event_cpi]
#[derive(Accounts)]
pub struct CloseBook<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.book @ MeridianError::AccountMismatch, close = rent_receiver)]
    pub book: AccountLoader<'info, OrderBook>,

    /// The automation wallet (D28, D29): the market creator key, which pays for books.
    /// CHECK: address checked against Config.
    #[account(mut, address = config.market_creator @ MeridianError::AccountMismatch)]
    pub rent_receiver: UncheckedAccount<'info>,

    /// Checked against `book.quote_vault`.
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = config.fee_vault @ MeridianError::AccountMismatch,
        token::mint = config.usdc_mint,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Permissionless. Once the market is SETTLED or VOID and the book holds no orders,
/// sweeps any accrued fees to the fee vault and closes the `OrderBook` account, rent to
/// the automation wallet (D29). Ledgers, vaults and mints stay: `withdraw` and `redeem`
/// keep working (CLN-06).
pub fn close_book(ctx: Context<CloseBook>) -> Result<()> {
    let ea_bump = ctx.bumps.event_authority;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), ea_bump);
    require!(
        matches!(a.market.status, MarketStatus::Settled | MarketStatus::Void),
        MeridianError::MarketNotSettled
    );
    let fees;
    {
        let mut bk = a.book.load_mut()?;
        require_keys_eq!(
            bk.quote_vault,
            a.quote_vault.key(),
            MeridianError::AccountMismatch
        );
        require!(bk.order_count == 0, MeridianError::BookNotEmpty);
        // No orders means nothing is locked.
        require!(
            bk.total_locked_usdc == 0 && bk.total_locked_yes == 0,
            MeridianError::InvariantViolated
        );
        fees = bk.fees_accrued;
        bk.fees_accrued = 0;
    }
    let slot = Clock::get()?.slot;
    let market = a.market.key();
    if fees > 0 {
        let signer = MarketSigner::new(&a.market);
        transfer(
            &a.token_program.to_account_info(),
            &a.quote_vault.to_account_info(),
            &a.fee_vault.to_account_info(),
            &a.market.to_account_info(),
            Some(&signer),
            fees,
        )?;
        let seq = a.market.next_seq()?;
        em.emit(&FeesSwept {
            market,
            slot,
            seq,
            amount: fees,
            fee_vault: a.fee_vault.key(),
        })?;
    }
    let seq = a.market.next_seq()?;
    em.emit(&BookClosed { market, slot, seq })?;
    Ok(())
}
