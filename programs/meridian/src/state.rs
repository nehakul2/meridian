//! On-chain accounts (spec 4.1). Field order is part of the contract.
use anchor_lang::prelude::*;

use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CloseSourceMode {
    OracleOfficial,
    AttestedChecked,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace,
)]
pub struct TickerEntry {
    /// ASCII symbol, zero-padded (e.g. "META\0\0\0\0").
    pub symbol: [u8; TICKER_LEN],
    /// Pyth price feed id.
    pub feed_id: [u8; 32],
}

impl TickerEntry {
    pub fn is_empty(&self) -> bool {
        self.symbol[0] == 0
    }

    pub fn symbol_str(&self) -> &str {
        let len = self
            .symbol
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(TICKER_LEN);
        core::str::from_utf8(&self.symbol[..len]).unwrap_or("")
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Config {
    pub admin: Pubkey,
    pub market_creator: Pubkey,
    pub settler: Pubkey,
    pub paused: bool,
    pub fee_bps: u16,
    pub fee_vault: Pubkey,
    pub usdc_mint: Pubkey,
    pub override_delay_s: i64,
    pub settle_window_s: i64,
    pub conf_bps_max: u16,
    pub close_tolerance_bps: u16,
    pub dispute_window_s: i64,
    pub dispute_bond: u64,
    pub dispute_resolution_s: i64,
    pub bond_vault: Pubkey,
    pub close_source_mode: CloseSourceMode,
    pub tickers: [TickerEntry; MAX_TICKERS],
    pub bump: u8,
}

impl Config {
    pub fn has_ticker(&self, symbol: &str) -> bool {
        !symbol.is_empty()
            && self
                .tickers
                .iter()
                .any(|t| !t.is_empty() && t.symbol_str() == symbol)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TickerDayStatus {
    Open,
    Provisional,
    Disputed,
    Final,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum FinalBasis {
    None,
    Undisputed,
    Upheld,
    Corrected,
    Deadline,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CloseSource {
    None,
    OracleOfficial,
    AttestedChecked,
    Admin,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct TickerDay {
    pub ticker: [u8; TICKER_LEN],
    /// ET calendar date, YYYYMMDD (D31).
    pub date: u32,
    pub mint_open_time: i64,
    pub open_time: i64,
    pub close_time: i64,
    pub status: TickerDayStatus,
    pub final_basis: FinalBasis,
    pub recorded_at: i64,
    pub price: i64,
    pub expo: i32,
    pub original_price: i64,
    pub close_source: CloseSource,
    pub ref_price: i64,
    pub ref_conf: u64,
    pub ref_publish_time: i64,
    pub recorded_by: Pubkey,
    pub strike_count: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Trading,
    Halted,
    Settled,
    Void,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    None,
    Yes,
    No,
    Void,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Market {
    pub ticker_day: Pubkey,
    pub ticker: [u8; TICKER_LEN],
    pub date: u32,
    pub strike_cents: u64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub book: Pubkey,
    pub pairs_outstanding: u64,
    pub collateral_accounted: u64,
    pub status: MarketStatus,
    pub outcome: Outcome,
    pub settle_price: i64,
    pub settle_expo: i32,
    pub total_minted: u64,
    pub total_trades: u64,
    /// Per-market monotonic event sequence (spec 4.6).
    pub seq: u64,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
}

impl Market {
    /// Returns the next event sequence number.
    pub fn next_seq(&mut self) -> Result<u64> {
        self.seq = self
            .seq
            .checked_add(1)
            .ok_or(crate::errors::MeridianError::Overflow)?;
        Ok(self.seq)
    }
}

/// Order book header. Price-level storage is defined by MER-20 (Phase 2),
/// which grows this account; Phase 1 creates the PDA so the address is fixed.
#[account]
#[derive(InitSpace, Debug)]
pub struct OrderBook {
    pub market: Pubkey,
    pub next_order_id: u64,
    pub order_count: u32,
    pub bump: u8,
}

/// Maker proceeds and locked balances per (market, owner) (spec 4.1, R4.6). Used from Phase 2.
#[account]
#[derive(InitSpace, Debug)]
pub struct UserLedger {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub free_usdc: u64,
    pub locked_usdc: u64,
    pub free_yes: u64,
    pub locked_yes: u64,
    pub open_order_count: u32,
    pub pending_buy_no: u64,
    pub bump: u8,
}

/// Encodes a ticker string into the fixed, zero-padded on-chain form.
pub fn encode_ticker(symbol: &str) -> Option<[u8; TICKER_LEN]> {
    let bytes = symbol.as_bytes();
    if bytes.is_empty()
        || bytes.len() > TICKER_LEN
        || !bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'.')
    {
        return None;
    }
    let mut out = [0u8; TICKER_LEN];
    out[..bytes.len()].copy_from_slice(bytes);
    Some(out)
}

/// Validates an ET trading date `YYYYMMDD` (D31). Calendar membership is checked off-chain (D25).
pub fn valid_date(date: u32) -> bool {
    let y = date / 10_000;
    let m = (date / 100) % 100;
    let d = date % 100;
    (2024..=2099).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)
}
