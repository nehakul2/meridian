//! Seeds, units and config defaults (spec 4.1, D4, D24, D27, D28, D8).

pub const CONFIG_SEED: &[u8] = b"config";
pub const TICKER_DAY_SEED: &[u8] = b"tday";
pub const MARKET_SEED: &[u8] = b"market";
pub const BOOK_SEED: &[u8] = b"book";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const YES_MINT_SEED: &[u8] = b"yes";
pub const NO_MINT_SEED: &[u8] = b"no";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DISPUTE_SEED: &[u8] = b"dispute";
/// PDA that owns the dispute bond vault (`Config.bond_vault`), so the program can return
/// or forward a bond (MER-37).
pub const BOND_AUTHORITY_SEED: &[u8] = b"bond";

/// Number of tickers held in `Config` (MAG7).
pub const MAX_TICKERS: usize = 7;
/// Maximum ticker symbol length in bytes (stored zero-padded).
pub const TICKER_LEN: usize = 8;

/// One contract pays $1.00 = 1,000,000 micro-USDC (USDC has 6 decimals, D24).
pub const MICRO_USDC_PER_PAIR: u64 = 1_000_000;
/// Void payout per token: $0.50 (D20).
pub const MICRO_USDC_VOID_PAYOUT: u64 = 500_000;
/// USDC decimals; the configured mint must match.
pub const USDC_DECIMALS: u8 = 6;

// Config defaults (spec 4.1).
pub const DEFAULT_OVERRIDE_DELAY_S: i64 = 1_800; // D4: 30 min
pub const DEFAULT_SETTLE_WINDOW_S: i64 = 5; // epsilon
pub const DEFAULT_CONF_BPS_MAX: u16 = 10; // D27
pub const DEFAULT_FEE_BPS: u16 = 0; // D28: 0 on devnet
pub const DEFAULT_CLOSE_TOLERANCE_BPS: u16 = 20; // D3 / 4.7
pub const DEFAULT_DISPUTE_WINDOW_S: i64 = 1_200; // D8: 20 min
pub const DEFAULT_DISPUTE_BOND: u64 = 100 * MICRO_USDC_PER_PAIR; // D8: 100 USDC
pub const DEFAULT_DISPUTE_RESOLUTION_S: i64 = 86_400; // D8: 24 h

// Config bounds enforced by `update_config` (MER-10, CFG-07).
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MAX_BPS: u16 = 10_000;
pub const MAX_SETTLE_WINDOW_S: i64 = 300;
pub const MAX_OVERRIDE_DELAY_S: i64 = 7 * 86_400;
pub const MAX_DISPUTE_WINDOW_S: i64 = 86_400;
pub const MAX_DISPUTE_RESOLUTION_S: i64 = 30 * 86_400;

// Order book (MER-20, D24, spec 4.1).
pub const BASE_VAULT_SEED: &[u8] = b"base";
pub const QUOTE_VAULT_SEED: &[u8] = b"quote";
/// Yes price levels: 1..=99 cents.
pub const MIN_PRICE: u8 = 1;
pub const MAX_PRICE: u8 = 99;
pub const PRICE_LEVELS: usize = 99;
/// One cent of price per contract, in micro-USDC (D24: 10,000 per cent).
pub const MICRO_USDC_PER_CENT: u64 = 10_000;
/// Resting orders per price level (FIFO). Bounds book size and worst-case compute.
pub const LEVEL_CAPACITY: usize = 8;
/// On-chain ceiling on one order's size. The 500-contract product cap (D6) is enforced by
/// the Tx Builder; this bound keeps every notional far from u64 overflow.
pub const MAX_ORDER_QTY: u64 = 1_000_000;
/// A program-owned account can grow by at most 10 KiB per instruction, so the book is
/// created at this size and grown to full size by `grow_book` (MER-20).
pub const BOOK_GROWTH_STEP: usize = 10_240;

// Settlement (MER-30 to MER-37).
/// Pyth Solana Receiver program: owner of every verified `PriceUpdateV2` account (A2).
pub const PYTH_RECEIVER_ID: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Anchor discriminator of `PriceUpdateV2`: sha256("account:PriceUpdateV2")[..8].
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
/// Price exponents accepted anywhere a price is written. Keeps every i128 comparison in
/// `settlement.rs` far from overflow (|i64| x 10^20 < 2^127).
pub const MIN_EXPO: i32 = -18;
pub const MAX_EXPO: i32 = 10;
/// Strike exponent: strikes are whole cents.
pub const STRIKE_EXPO: i32 = -2;
/// Upper bound on one `prune_orders` call, so a call always fits the compute budget.
pub const MAX_PRUNE_BATCH: u16 = 64;
