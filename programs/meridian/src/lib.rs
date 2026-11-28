//! Meridian: binary Yes/No outcome markets on MAG7 daily closes (Solana, Anchor).
//!
//! Phase 1 (program core): config and roles, ticker-days, strike markets,
//! mint/merge with accounted collateral, invariants, and pause.
//! Phase 2 (order book): zero-copy CLOB with halt at close and the four trade paths
//! (Buy Yes / Sell Yes via place_order, buy_no_market, buy_no_limit, sell_no), cancel,
//! withdraw and the taker fee.
//! Phase 3 (settlement): record_close with the Pyth cross-check, admin override, the
//! dispute window, per-strike settle, redeem, void, prune and close_book.
use anchor_lang::prelude::*;

pub mod book;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod invariants;
pub mod settlement;
pub mod state;

use events::{Side, TimeInForce};
use instructions::*;
use state::Outcome;

declare_id!("LAsZhW497YdYdPcpNrjhM5FkJdQiLe4ogrgVAttRvix");

#[program]
pub mod meridian {
    use super::*;

    /// Creates `Config` once. Signer must be the program's upgrade authority.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        instructions::config::initialize_config(ctx, args)
    }

    /// Admin only. Roles, fees, thresholds, tickers (bounds-checked).
    pub fn update_config(ctx: Context<UpdateConfig>, update: ConfigUpdate) -> Result<()> {
        instructions::config::update_config(ctx, update)
    }

    /// market_creator only; idempotent. Times are UTC unix seconds for the ET date.
    pub fn create_ticker_day(
        ctx: Context<CreateTickerDay>,
        ticker: String,
        date: u32,
        mint_open_time: i64,
        open_time: i64,
        close_time: i64,
    ) -> Result<()> {
        instructions::ticker_day::create_ticker_day(
            ctx,
            ticker,
            date,
            mint_open_time,
            open_time,
            close_time,
        )
    }

    /// market_creator only; idempotent.
    pub fn create_strike_market(ctx: Context<CreateMarket>, strike_cents: u64) -> Result<()> {
        instructions::market::create_market(ctx, strike_cents, CreateRole::Creator)
    }

    /// Admin only; same code path as create_strike_market (strikes are add-only, D20).
    pub fn add_strike(ctx: Context<CreateMarket>, strike_cents: u64) -> Result<()> {
        instructions::market::create_market(ctx, strike_cents, CreateRole::Admin)
    }

    /// n x $1.00 USDC into the vault; mint n Yes + n No.
    pub fn mint_pair(ctx: Context<MintMerge>, n: u64) -> Result<()> {
        instructions::mint_merge::mint_pair(ctx, n)
    }

    /// Burn n Yes + n No; n x $1.00 USDC back. Works while paused and after the halt.
    pub fn merge_pair(ctx: Context<MintMerge>, n: u64) -> Result<()> {
        instructions::mint_merge::merge_pair(ctx, n)
    }

    /// Permissionless. Grows the market's order book by 10 KiB until it reaches full size.
    pub fn grow_book(ctx: Context<GrowBook>) -> Result<()> {
        instructions::market::grow_book(ctx)
    }

    /// Buy Yes (BID) or Sell Yes (ASK). `price` is the limit, or the worst price for IOC.
    /// Makers' UserLedgers go in remaining accounts.
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
        side: Side,
        price: u8,
        qty: u64,
        tif: TimeInForce,
        client_id: u64,
    ) -> Result<()> {
        instructions::trade::place_order(ctx, side, price, qty, tif, client_id)
    }

    /// Buy No at market: mint exactly the fillable quantity and sell that Yes into bids
    /// at `min_yes_price` or better. Fails with NoLiquidity if nothing fills.
    pub fn buy_no_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
        qty: u64,
        min_yes_price: u8,
    ) -> Result<()> {
        instructions::trade::buy_no_market(ctx, qty, min_yes_price)
    }

    /// Buy No limit: mint `qty` pairs and offer the Yes at `yes_price`, tagged BUY_NO.
    pub fn buy_no_limit<'info>(
        ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
        qty: u64,
        yes_price: u8,
    ) -> Result<()> {
        instructions::trade::buy_no_limit(ctx, qty, yes_price)
    }

    /// Sell No: buy Yes up to `max_yes_price` (IOC, capped at `qty`) and merge it.
    pub fn sell_no<'info>(
        ctx: Context<'_, '_, 'info, 'info, Trade<'info>>,
        qty: u64,
        max_yes_price: u8,
    ) -> Result<()> {
        instructions::trade::sell_no(ctx, qty, max_yes_price)
    }

    /// Owner only; always allowed. A BUY_NO order merges its unfilled Yes with No.
    pub fn cancel_order(ctx: Context<CancelOrders>, order_id: u64) -> Result<()> {
        instructions::cancel_withdraw::cancel_order(ctx, order_id)
    }

    /// Cancels every resting order of the signer in this market.
    pub fn cancel_all(ctx: Context<CancelOrders>) -> Result<()> {
        instructions::cancel_withdraw::cancel_all(ctx)
    }

    /// Ledger free USDC and Yes to the owner's token accounts. Always allowed.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::cancel_withdraw::withdraw(ctx)
    }

    /// Permissionless. Moves a market's accrued taker fees to Config.fee_vault.
    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        instructions::cancel_withdraw::sweep_fees(ctx)
    }

    /// Admin only. Stops entry (mint_pair, new orders) only (D30).
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::set_paused(ctx, true)
    }

    /// Admin only.
    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::set_paused(ctx, false)
    }

    // ---- Phase 3: settlement, redeem, cleanup ----

    /// Settler only. Records the official close (D3), cross-checked against a fully
    /// verified Pyth update stamped in [close_time, close_time + settle_window_s].
    /// `official` is required in ATTESTED_CHECKED mode and refused in ORACLE_OFFICIAL.
    pub fn record_close(ctx: Context<RecordClose>, official: Option<OfficialClose>) -> Result<()> {
        instructions::close::record_close(ctx, official)
    }

    /// Admin only, from close_time + override_delay_s while the close is unrecorded.
    pub fn admin_settle(ctx: Context<AdminSettle>, price: i64, expo: i32) -> Result<()> {
        instructions::close::admin_settle(ctx, price, expo)
    }

    /// Anyone, during the dispute window, with the configured USDC bond.
    pub fn raise_dispute(ctx: Context<RaiseDispute>, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::close::raise_dispute(ctx, evidence_hash)
    }

    /// Admin only, before the resolution deadline. Uphold or correct (once).
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, resolution: Resolution) -> Result<()> {
        instructions::close::resolve_dispute(ctx, resolution)
    }

    /// Permissionless. PROVISIONAL past the window, or DISPUTED past the deadline -> FINAL.
    pub fn finalize_close(ctx: Context<FinalizeClose>) -> Result<()> {
        instructions::close::finalize_close(ctx)
    }

    /// Permissionless. Settles one strike from its ticker-day's FINAL price.
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle::settle_market(ctx)
    }

    /// Admin only. Settles a strike that settle_market refused (confidence band).
    pub fn admin_settle_market(ctx: Context<AdminSettleMarket>, outcome: Outcome) -> Result<()> {
        instructions::settle::admin_settle_market(ctx, outcome)
    }

    /// Admin only, zero trades. Yes and No each redeem for $0.50.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::settle::void_market(ctx)
    }

    /// Burn tokens for their settled value. SETTLED or VOID; works forever.
    pub fn redeem(ctx: Context<Redeem>, yes_n: u64, no_n: u64) -> Result<()> {
        instructions::settle::redeem(ctx, yes_n, no_n)
    }

    /// Permissionless, after close_time. Cancels up to `max` resting orders to ledgers.
    pub fn prune_orders<'info>(
        ctx: Context<'_, '_, 'info, 'info, PruneOrders<'info>>,
        max: u16,
    ) -> Result<()> {
        instructions::cleanup::prune_orders(ctx, max)
    }

    /// Permissionless. Closes an empty, settled book; rent to the automation wallet.
    pub fn close_book(ctx: Context<CloseBook>) -> Result<()> {
        instructions::cleanup::close_book(ctx)
    }
}
