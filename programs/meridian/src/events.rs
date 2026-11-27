//! Events emitted via `emit_cpi!` (spec 4.6). This is the Indexer's contract.
//!
//! Every event carries `market`, `slot` and `seq`. `seq` is the per-market
//! monotonic counter in `Market.seq`. Events that are not about one market
//! (`Paused`, `Unpaused`, and the ticker-day level `Close*` / `Dispute*`
//! events) put the Config or TickerDay address in `market` and `seq = 0`.
use anchor_lang::prelude::*;

use crate::state::{FinalBasis, Outcome};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Via {
    Direct,
    BuyNo,
    SellNo,
    CancelBuyNo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum OrderTag {
    None,
    BuyNo,
    SellNo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid,
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimeInForce {
    Ioc,
    Gtc,
    PostOnly,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum CancelReason {
    User,
    Prune,
    IocRemainder,
    /// The taker met its own resting order; the resting order is cancelled (MER-20).
    SelfTrade,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisputeResult {
    Upheld,
    Corrected,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub ticker_day: Pubkey,
    pub ticker: [u8; 8],
    pub date: u32,
    pub strike_cents: u64,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub book: Pubkey,
    pub created_by: Pubkey,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: Side,
    pub price: u8,
    pub qty: u64,
    pub tif: TimeInForce,
    pub tag: OrderTag,
    pub client_id: u64,
}

#[event]
pub struct Fill {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub maker_order_id: u64,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub side: Side,
    pub price: u8,
    pub qty: u64,
    pub taker_fee: u64,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: Side,
    pub price: u8,
    /// Quantity removed from the book (the unfilled remainder).
    pub qty: u64,
    pub reason: CancelReason,
}

#[event]
pub struct PairMinted {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub owner: Pubkey,
    pub n: u64,
    pub via: Via,
}

#[event]
pub struct PairMerged {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub owner: Pubkey,
    pub n: u64,
    pub via: Via,
}

#[event]
pub struct Withdrawn {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub owner: Pubkey,
    pub usdc: u64,
    pub yes: u64,
}

#[event]
pub struct CloseRecorded {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub ticker: [u8; 8],
    pub date: u32,
    pub price: i64,
    pub expo: i32,
    pub conf: u64,
    pub publish_time: i64,
    pub by: Pubkey,
    pub r#override: bool,
}

#[event]
pub struct DisputeRaised {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub ticker: [u8; 8],
    pub date: u32,
    pub by: Pubkey,
    pub bond: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct DisputeResolved {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub ticker: [u8; 8],
    pub date: u32,
    pub result: DisputeResult,
    pub old_price: i64,
    pub new_price: i64,
}

#[event]
pub struct CloseFinalized {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub ticker: [u8; 8],
    pub date: u32,
    pub price: i64,
    pub basis: FinalBasis,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub outcome: Outcome,
    pub settle_price: i64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub owner: Pubkey,
    pub yes_n: u64,
    pub no_n: u64,
    pub paid: u64,
}

#[event]
pub struct Paused {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub by: Pubkey,
}

#[event]
pub struct Unpaused {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub by: Pubkey,
}

/// Accrued taker fees moved from a market's quote vault to `Config.fee_vault` (MER-25).
#[event]
pub struct FeesSwept {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
    pub amount: u64,
    pub fee_vault: Pubkey,
}

#[event]
pub struct BookClosed {
    pub market: Pubkey,
    pub slot: u64,
    pub seq: u64,
}
