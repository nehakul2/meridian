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
    // ---- Phase 3: settlement, redeem, cleanup ----
    #[msg("Price must be greater than zero")]
    InvalidOraclePrice,
    #[msg("Price exponent out of range")]
    InvalidExpo,
    #[msg("Oracle account is not a Pyth PriceUpdateV2 owned by the Pyth receiver")]
    InvalidOracleAccount,
    #[msg("Oracle update is not fully verified")]
    OracleNotFullyVerified,
    #[msg("Oracle feed id does not match the ticker")]
    FeedMismatch,
    #[msg("Oracle publish_time is outside [close_time, close_time + settle_window_s]")]
    PublishTimeOutsideWindow,
    #[msg("Oracle confidence is wider than conf_bps_max")]
    ConfidenceTooWide,
    #[msg("Official close is outside the tolerance of the oracle reference")]
    CrossCheckFailed,
    #[msg("Official close exponent must match the reference update")]
    ExpoMismatch,
    #[msg("This close source mode needs an attested official close")]
    OfficialCloseRequired,
    #[msg("ORACLE_OFFICIAL mode reads the feed; an attested value is refused")]
    OfficialCloseNotAllowed,
    #[msg("Not yet: now < close_time")]
    CloseNotReached,
    #[msg("Admin override not yet allowed: now < close_time + override_delay_s")]
    OverrideTooEarly,
    #[msg("Ticker-day close is not FINAL")]
    TickerDayNotFinal,
    #[msg("Confidence band straddles the strike; this strike goes to the admin path")]
    ConfidenceStraddle,
    #[msg("Strike is outside the confidence band; use settle_market")]
    NotInConfidenceBand,
    #[msg("Market is not settled or void")]
    MarketNotSettled,
    #[msg("Market has trades and cannot be voided")]
    MarketHasTrades,
    #[msg("Ticker-day close is not PROVISIONAL")]
    NotProvisional,
    #[msg("Ticker-day close is not DISPUTED")]
    NotDisputed,
    #[msg("Dispute window has closed")]
    DisputeWindowClosed,
    #[msg("Dispute window is still open")]
    DisputeWindowOpen,
    #[msg("Dispute resolution deadline has passed")]
    ResolutionDeadlinePassed,
    #[msg("Dispute resolution deadline has not passed")]
    ResolutionDeadlineNotReached,
    #[msg("Bond vault must be a USDC account owned by the bond authority PDA")]
    InvalidBondVault,
    #[msg("Orders can be pruned only after close_time or once settled or void")]
    PruneNotAllowed,
    #[msg("Order book still has resting orders")]
    BookNotEmpty,
    #[msg("Order book account is closed")]
    BookClosed,
}
