//! MER-21 (cancel_order, cancel_all, withdraw) and MER-23 (auto-merge on BUY_NO cancel).
//!
//! These are exits: they work while paused and after the halt at close (D12, D30).
//! A cancelled order's remainder is unlocked to the owner's `UserLedger` free balances;
//! `withdraw` moves free balances to the owner's token accounts.
//!
//! BUY_NO cancel (D15): the unfilled Yes is merged with the same number of the owner's
//! No and paid out as $1.00 USDC per pair. If the owner no longer holds enough No (for
//! example they transferred it away), the rest of the Yes stays in the ledger as free Yes.
//! After settlement the merge is not possible (merge_pair is closed); the
//! post-settlement conversion belongs to `prune_orders` (MER-35, CLN-02).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::book::Balances;
use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::*;
use crate::instructions::market::ticker_seed;
use crate::instructions::token_ops::*;
use crate::instructions::trade::side_of;
use crate::invariants::{assert_book_escrow, assert_invariants, MarketSnapshot};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
pub struct CancelOrders<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.book @ MeridianError::AccountMismatch)]
    pub book: AccountLoader<'info, OrderBook>,

    #[account(
        mut,
        seeds = [LEDGER_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, UserLedger>>,

    /// Checked against `book.base_vault`.
    #[account(mut)]
    pub base_vault: Box<Account<'info, TokenAccount>>,

    /// Checked against `book.quote_vault`.
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = no_mint,
        associated_token::authority = owner,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_order(ctx: Context<CancelOrders>, order_id: u64) -> Result<()> {
    cancel(ctx, Some(order_id))
}

pub fn cancel_all(ctx: Context<CancelOrders>) -> Result<()> {
    cancel(ctx, None)
}

fn cancel(ctx: Context<CancelOrders>, only: Option<u64>) -> Result<()> {
    let bump = ctx.bumps.event_authority;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    let owner = a.owner.key();
    let mut bal = Balances::of(&a.ledger);
    let mut cancelled: Vec<(usize, u8, BookOrder)> = vec![];
    let mut buy_no_unfilled: u64 = 0;
    let can_merge = matches!(
        a.market.status,
        MarketStatus::Trading | MarketStatus::Halted
    );
    let merge_n;
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
        let ids: Vec<u64> = match only {
            Some(id) => {
                let (side, price, i) = bk.find(id).ok_or(MeridianError::OrderNotFound)?;
                require_keys_eq!(
                    bk.level(side, price).orders[i].owner,
                    owner,
                    MeridianError::Unauthorized
                );
                vec![id]
            }
            None => bk
                .orders_of(&owner)
                .into_iter()
                .map(|(_, _, id)| id)
                .collect(),
        };
        for id in ids {
            let (side, price, o) = bk.cancel(id, &mut bal)?;
            if o.tag == ORDER_TAG_BUY_NO {
                buy_no_unfilled = buy_no_unfilled
                    .checked_add(o.qty)
                    .ok_or(MeridianError::Overflow)?;
            }
            cancelled.push((side, price, o));
        }
        merge_n = if can_merge {
            buy_no_unfilled.min(a.user_no.amount)
        } else {
            0
        };
        // The merged Yes leaves the ledger (it is burned from the base vault below).
        bk.take_free(&mut bal, 0, merge_n)?;
    }
    bal.store(&mut a.ledger);

    if merge_n > 0 {
        let collateral = merge_n
            .checked_mul(MICRO_USDC_PER_PAIR)
            .ok_or(MeridianError::Overflow)?;
        let tp = a.token_program.to_account_info();
        let signer = MarketSigner::new(&a.market);
        let mkt = a.market.to_account_info();
        burn(
            &tp,
            &a.yes_mint.to_account_info(),
            &a.base_vault.to_account_info(),
            &mkt,
            Some(&signer),
            merge_n,
        )?;
        burn(
            &tp,
            &a.no_mint.to_account_info(),
            &a.user_no.to_account_info(),
            &a.owner.to_account_info(),
            None,
            merge_n,
        )?;
        transfer(
            &tp,
            &a.vault.to_account_info(),
            &a.user_usdc.to_account_info(),
            &mkt,
            Some(&signer),
            collateral,
        )?;
        let mk = &mut a.market;
        mk.pairs_outstanding = mk
            .pairs_outstanding
            .checked_sub(merge_n)
            .ok_or(MeridianError::InvariantViolated)?;
        mk.collateral_accounted = mk
            .collateral_accounted
            .checked_sub(collateral)
            .ok_or(MeridianError::InvariantViolated)?;
    }

    let slot = Clock::get()?.slot;
    let market = a.market.key();
    for (side, price, o) in &cancelled {
        let seq = a.market.next_seq()?;
        em.emit(&OrderCancelled {
            market,
            slot,
            seq,
            order_id: o.order_id,
            owner,
            side: side_of(*side),
            price: *price,
            qty: o.qty,
            reason: CancelReason::User,
        })?;
    }
    if merge_n > 0 {
        let seq = a.market.next_seq()?;
        em.emit(&PairMerged {
            market,
            slot,
            seq,
            owner,
            n: merge_n,
            via: Via::CancelBuyNo,
        })?;
    }

    a.base_vault.reload()?;
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

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: the market's order book (address checked). After `close_book` (MER-35) it
    /// no longer exists and withdraw works from the ledger alone (CLN-06).
    #[account(mut, address = market.book @ MeridianError::AccountMismatch)]
    pub book: UncheckedAccount<'info>,

    /// Seeds bind the ledger to the signer: nobody can withdraw another user's ledger (SEC-03).
    #[account(
        mut,
        seeds = [LEDGER_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, UserLedger>>,

    #[account(mut)]
    pub base_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = yes_mint,
        associated_token::authority = owner,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Moves all free USDC and free Yes from the ledger to the owner. Always allowed.
pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let bump = ctx.bumps.event_authority;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    let mut bal = Balances::of(&a.ledger);
    let (usdc, yes) = (bal.free_usdc, bal.free_yes);
    let book_info = a.book.to_account_info();
    let open = book_open(&book_info);
    if open {
        let mut data = book_info.try_borrow_mut_data()?;
        let bk: &mut OrderBook = bytemuck::from_bytes_mut(&mut data[8..OrderBook::LEN]);
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
        bk.take_free(&mut bal, usdc, yes)?;
    } else {
        // Book closed: no orders, so only free balances remain. The vaults are the
        // market's PDAs; the ledger is the whole claim on them.
        let mkey = a.market.key();
        let (base, _) = Pubkey::find_program_address(&[BASE_VAULT_SEED, mkey.as_ref()], &crate::ID);
        let (quote, _) =
            Pubkey::find_program_address(&[QUOTE_VAULT_SEED, mkey.as_ref()], &crate::ID);
        require_keys_eq!(base, a.base_vault.key(), MeridianError::AccountMismatch);
        require_keys_eq!(quote, a.quote_vault.key(), MeridianError::AccountMismatch);
        bal.free_usdc = 0;
        bal.free_yes = 0;
    }
    bal.store(&mut a.ledger);
    let tp = a.token_program.to_account_info();
    let signer = MarketSigner::new(&a.market);
    let mkt = a.market.to_account_info();
    transfer(
        &tp,
        &a.quote_vault.to_account_info(),
        &a.user_usdc.to_account_info(),
        &mkt,
        Some(&signer),
        usdc,
    )?;
    transfer(
        &tp,
        &a.base_vault.to_account_info(),
        &a.user_yes.to_account_info(),
        &mkt,
        Some(&signer),
        yes,
    )?;

    let slot = Clock::get()?.slot;
    let seq = a.market.next_seq()?;
    em.emit(&Withdrawn {
        market: a.market.key(),
        slot,
        seq,
        owner: a.owner.key(),
        usdc,
        yes,
    })?;
    if open {
        a.base_vault.reload()?;
        a.quote_vault.reload()?;
        let data = book_info.try_borrow_data()?;
        let bk: &OrderBook = bytemuck::from_bytes(&data[8..OrderBook::LEN]);
        assert_book_escrow(a.base_vault.amount, a.quote_vault.amount, bk)?;
    }
    Ok(())
}

/// True while the order book account exists and is fully grown.
fn book_open(info: &AccountInfo) -> bool {
    info.owner == &crate::ID
        && info.data_len() == OrderBook::LEN
        && info
            .try_borrow_data()
            .map(|d| d[..8] == *OrderBook::DISCRIMINATOR)
            .unwrap_or(false)
}

#[event_cpi]
#[derive(Accounts)]
pub struct SweepFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.book @ MeridianError::AccountMismatch)]
    pub book: AccountLoader<'info, OrderBook>,

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

/// Permissionless (MER-25). Moves a market's accrued taker fees to `Config.fee_vault`.
/// Run by automation (and by close_book in Phase 3); always allowed.
pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
    let bump = ctx.bumps.event_authority;
    let a = ctx.accounts;
    let mut em = Emitter::new(a.event_authority.to_account_info(), bump);
    let amount;
    {
        let mut bk = a.book.load_mut()?;
        require_keys_eq!(
            bk.quote_vault,
            a.quote_vault.key(),
            MeridianError::AccountMismatch
        );
        amount = bk.fees_accrued;
        bk.fees_accrued = 0;
    }
    if amount == 0 {
        return Ok(());
    }
    let signer = MarketSigner::new(&a.market);
    transfer(
        &a.token_program.to_account_info(),
        &a.quote_vault.to_account_info(),
        &a.fee_vault.to_account_info(),
        &a.market.to_account_info(),
        Some(&signer),
        amount,
    )?;
    let slot = Clock::get()?.slot;
    let seq = a.market.next_seq()?;
    em.emit(&FeesSwept {
        market: a.market.key(),
        slot,
        seq,
        amount,
        fee_vault: a.fee_vault.key(),
    })?;
    a.quote_vault.reload()?;
    let bk = a.book.load()?;
    // Base side is unaffected; pass u64::MAX so only the USDC side is checked here.
    assert_book_escrow(u64::MAX, a.quote_vault.amount, &bk)
}
