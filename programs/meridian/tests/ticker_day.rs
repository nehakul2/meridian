//! MER-11 · create_ticker_day with calendar times.
//! Matrix: CAL-02, CAL-06, MNT-12.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    state::{TickerDay, TickerDayStatus},
};
use solana_sdk::pubkey::Pubkey;

#[test]
fn ticker_day_pda_and_fields() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let pda = ticker_day_pda("META", DATE);
    let (expected, bump) = Pubkey::find_program_address(
        &[b"tday", b"META", &20261125u32.to_le_bytes()],
        &meridian::ID,
    );
    assert_eq!(pda, expected);
    let td: TickerDay = env.fetch(&pda);
    assert_eq!(&td.ticker[..4], b"META");
    assert_eq!(td.date, 20261125);
    assert_eq!(
        (td.mint_open_time, td.open_time, td.close_time),
        (MINT_OPEN, OPEN, CLOSE)
    );
    assert_eq!(td.status, TickerDayStatus::Open);
    assert_eq!(td.strike_count, 0);
    assert_eq!(td.bump, bump);
}

#[test]
fn ticker_day_non_creator_rejected() {
    let mut env = Env::new();
    let eve = env.user(0);
    let admin = env.admin.insecure_clone();
    for k in [&eve, &admin] {
        assert_err(
            env.create_ticker_day_as(k, "META", DATE, MINT_OPEN, OPEN, CLOSE),
            MeridianError::Unauthorized,
        );
    }
    assert!(!env.exists(&ticker_day_pda("META", DATE)));
}

#[test]
fn ticker_day_rerun_is_noop_success() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let before = env.svm.get_account(&ticker_day_pda("META", DATE)).unwrap();
    // Same args, and different args: both succeed and change nothing (A25).
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    env.create_ticker_day("META", DATE, MINT_OPEN + 60, OPEN + 60, CLOSE + 60)
        .unwrap();
    let after = env.svm.get_account(&ticker_day_pda("META", DATE)).unwrap();
    assert_eq!(before.data, after.data);
}

#[test]
fn ticker_day_unknown_ticker_rejected() {
    let mut env = Env::new();
    assert_err(
        env.create_ticker_day("NFLX", DATE, MINT_OPEN, OPEN, CLOSE),
        MeridianError::UnknownTicker,
    );
}

#[test]
fn ticker_day_rejects_bad_times_and_dates() {
    let mut env = Env::new();
    // D26: mint_open_time <= open_time < close_time.
    assert_err(
        env.create_ticker_day("META", DATE, OPEN + 1, OPEN, CLOSE),
        MeridianError::InvalidTimes,
    );
    assert_err(
        env.create_ticker_day("META", DATE, MINT_OPEN, CLOSE, CLOSE),
        MeridianError::InvalidTimes,
    );
    assert_err(
        env.create_ticker_day("META", DATE, MINT_OPEN, CLOSE + 1, CLOSE),
        MeridianError::InvalidTimes,
    );
    // mint_open_time == open_time is allowed.
    env.create_ticker_day("AAPL", DATE, OPEN, OPEN, CLOSE)
        .unwrap();
    for bad in [20261325u32, 20261100, 20261132, 19991125, 2026112] {
        assert_err(
            env.create_ticker_day("MSFT", bad, MINT_OPEN, OPEN, CLOSE),
            MeridianError::InvalidDate,
        );
    }
}

#[test]
fn cal_02_half_day_close_stored_as_given() {
    // 2026-11-27 (day after Thanksgiving) closes 13:00 ET = 18:00 UTC.
    let mut env = Env::new();
    let (mint_open, open, close) = (1_795_786_200, 1_795_789_800, 1_795_802_400);
    env.create_ticker_day("META", 20261127, mint_open, open, close)
        .unwrap();
    let td: TickerDay = env.fetch(&ticker_day_pda("META", 20261127));
    assert_eq!(td.close_time, close);
    // Minting stops at the half-day close, not 16:00 (order halt is covered in MER-20).
    env.create_market("META", 20261127, STRIKE_680).unwrap();
    let m = market_pda("META", 20261127, STRIKE_680);
    let bob = env.user(10 * USDC);
    env.warp(close - 1);
    env.mint_pair(&bob, &m, 1).unwrap();
    env.warp(close);
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::MarketClosed);
}

#[test]
fn cal_06_trading_date_key_is_the_et_date() {
    // Markets for the 11-25 session are keyed 20261125 regardless of the UTC time of
    // the close (21:00 UTC 11-25) or of a 20:00 ET event (01:00 UTC 11-26).
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    env.create_market("META", DATE, STRIKE_680).unwrap();
    let m = env.market(&market_pda("META", DATE, STRIKE_680));
    assert_eq!(m.date, 20261125);
    assert_eq!(m.ticker_day, ticker_day_pda("META", 20261125));
    assert_ne!(
        ticker_day_pda("META", 20261125),
        ticker_day_pda("META", 20261126)
    );
    assert!(!env.exists(&ticker_day_pda("META", 20261126)));
    let seeds_pda = Pubkey::find_program_address(
        &[
            MARKET_SEED,
            b"META",
            &20261125u32.to_le_bytes(),
            &STRIKE_680.to_le_bytes(),
        ],
        &meridian::ID,
    )
    .0;
    assert_eq!(seeds_pda, market_pda("META", DATE, STRIKE_680));
}

#[test]
fn mnt_12_mint_rejected_before_mint_open_time() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(10 * USDC);
    env.warp(MINT_OPEN - 1);
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::MintNotOpen);
    env.warp(MINT_OPEN);
    env.mint_pair(&bob, &m, 1).unwrap();
}
