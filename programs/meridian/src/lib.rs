//! Meridian: binary Yes/No outcome markets on MAG7 daily closes (Solana, Anchor).
//!
//! Phase 1 (program core): config and roles, ticker-days, strike markets,
//! mint/merge with accounted collateral, invariants, and pause.
//! Later phases add the order book, settlement, redeem and cleanup.
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod invariants;
pub mod state;

use instructions::*;

declare_id!("2U1R1Y6LNi9GoAp1TMo2JXssjxxnJe5iLf6g2PLzXmhL");

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

    /// Admin only. Stops entry (mint_pair, new orders) only (D30).
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::set_paused(ctx, true)
    }

    /// Admin only.
    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::set_paused(ctx, false)
    }
}
