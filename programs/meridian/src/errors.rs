use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Signer is not authorised for this instruction")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Config value out of range")]
    InvalidConfig,
    #[msg("Role keys must be distinct")]
    RolesNotDistinct,
    #[msg("Ticker list is invalid (empty, too long, or duplicated)")]
    InvalidTickers,
    #[msg("Ticker is not in Config")]
    UnknownTicker,
    #[msg("Trading date must be an ET calendar date YYYYMMDD")]
    InvalidDate,
    #[msg("Times must satisfy mint_open_time <= open_time < close_time")]
    InvalidTimes,
    #[msg("Ticker-day is not open")]
    TickerDayNotOpen,
    #[msg("Market is closed: now >= close_time")]
    MarketClosed,
    #[msg("Minting has not opened yet")]
    MintNotOpen,
    #[msg("Strike must be greater than zero")]
    InvalidStrike,
    #[msg("Market is not trading")]
    MarketNotTrading,
    #[msg("Market is settled or void; use redeem")]
    MarketSettled,
    #[msg("Quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Account does not match the market")]
    AccountMismatch,
    #[msg("Collateral mint must be a 6-decimal USDC mint")]
    InvalidUsdcMint,
    #[msg("Not enough Yes and No tokens")]
    InsufficientTokens,
    #[msg("Invariant violated")]
    InvariantViolated,
    #[msg("Order book is not open yet: now < open_time")]
    MarketNotOpen,
    #[msg("Trading halted: now >= close_time")]
    MarketHalted,
    #[msg("Price must be 1 to 99 cents")]
    InvalidPrice,
    #[msg("Order is larger than the on-chain maximum")]
    OrderTooLarge,
    #[msg("Price level is full")]
    LevelFull,
    #[msg("Post-only order would cross the book")]
    WouldCross,
    #[msg("No bids at or above the minimum Yes price")]
    NoLiquidity,
    #[msg("Order not found")]
    OrderNotFound,
    #[msg("A maker's ledger was not passed, and the remainder would cross the book")]
    MakerLedgerMissing,
    #[msg("Not enough USDC")]
    InsufficientFunds,
}
