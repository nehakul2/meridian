//! MER-32 · settle_market per strike from the FINAL ticker-day price, with the
//! confidence-straddle refusal (D10, D11, D27, D8).
//! Matrix: SET-01 to SET-10 (SET-03/04 also in price_compare.rs, SET-11 there too).
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::MarketSettled,
    state::{MarketStatus, Outcome},
};
use solana_sdk::{pubkey::Pubkey, signature::Keypair};

/// M680 with bob holding 10 pairs, clock at the close.
fn setup() -> (Env, Pubkey, Keypair) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m, 10).unwrap();
    (env, m, bob)
}

#[test]
fn set_01_above_strike_settles_yes() {
    let (mut env, m, _) = setup();
    env.close_at(px(68_500));
    let meta = env.settle(&m).unwrap();
    let mk = env.market(&m);
    assert_eq!(
        (mk.status, mk.outcome),
        (MarketStatus::Settled, Outcome::Yes)
    );
    assert_eq!((mk.settle_price, mk.settle_expo), (px(68_500), EXPO));
    let yes_supply = env.mint_info(&mk.yes_mint).supply;
    assert_eq!(mk.collateral_accounted, yes_supply * USDC);
    assert_eq!(mk.collateral_accounted, 10 * USDC);
    let ev = &events::<MarketSettled>(&meta)[0];
    assert_eq!(
        (ev.market, ev.outcome, ev.settle_price),
        (m, Outcome::Yes, px(68_500))
    );
}

#[test]
fn set_02_below_strike_settles_no() {
    let (mut env, m, _) = setup();
    env.close_at(px(67_500));
    env.settle(&m).unwrap();
    let mk = env.market(&m);
    assert_eq!(mk.outcome, Outcome::No);
    assert_eq!(
        mk.collateral_accounted,
        env.mint_info(&mk.no_mint).supply * USDC
    );
}

#[test]
fn set_03_exactly_at_strike_settles_yes() {
    let (mut env, m, _) = setup();
    env.close_with(Update::meta(px(68_000), 0));
    env.settle(&m).unwrap();
    assert_eq!(env.market(&m).outcome, Outcome::Yes);
}

#[test]
fn set_04_one_unit_below_strike_settles_no() {
    let (mut env, m, _) = setup();
    env.close_with(Update::meta(67_999_999, 0));
    env.settle(&m).unwrap();
    assert_eq!(env.market(&m).outcome, Outcome::No);
}

#[test]
fn set_05_all_strikes_of_a_ticker_settle_on_one_price() {
    let (mut env, _, _) = setup();
    let strikes = [62_000u64, 64_000, 66_000, 70_000, 72_000, 74_000];
    for s in strikes {
        env.create_market("META", DATE, s).unwrap();
    }
    env.add_strike("META", DATE, 69_000).unwrap();
    env.close_at(px(68_500));
    let mut all: Vec<u64> = strikes.to_vec();
    all.extend([68_000, 69_000]);
    for s in &all {
        env.warp(env.now() + 1); // a different slot each
        env.settle(&market_pda("META", DATE, *s)).unwrap();
    }
    for s in all {
        let mk = env.market(&market_pda("META", DATE, s));
        assert_eq!(mk.settle_price, px(68_500), "strike {s}");
        let want = if s <= 68_000 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        assert_eq!(mk.outcome, want, "strike {s}");
    }
}

#[test]
fn set_06_confidence_band_straddling_strike_is_refused() {
    let (mut env, m680, _) = setup();
    env.warp(OPEN);
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let mut u = Update::meta(68_020_000, 0); // 680.20
    u.conf = 30_000; // 0.30, 4.4 bps: passes record_close
    env.close_with(u);
    assert_err(env.settle(&m680), MeridianError::ConfidenceStraddle);
    let mk = env.market(&m680);
    assert_eq!(
        (mk.status, mk.outcome),
        (MarketStatus::Trading, Outcome::None),
        "unsettled, for the admin path"
    );
    env.settle(&m700).unwrap();
    assert_eq!(env.market(&m700).outcome, Outcome::No);
}

#[test]
fn set_07_second_settle_is_a_clean_no_op() {
    let (mut env, m, _) = setup();
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    let before = env.market(&m);
    let meta = env.settle(&m).unwrap();
    assert!(events::<MarketSettled>(&meta).is_empty(), "no second event");
    let after = env.market(&m);
    assert_eq!((after.outcome, after.seq), (before.outcome, before.seq));
}

#[test]
fn set_08_settle_is_permissionless_once_final() {
    let (mut env, m, _) = setup();
    env.close_at(px(68_500));
    let eve = env.user(0);
    env.settle_as(&eve, &m).unwrap();
    assert_eq!(env.market(&m).settle_price, px(68_500));
}

#[test]
fn set_09_cannot_settle_before_record() {
    let (mut env, m, _) = setup();
    env.warp(CLOSE + 600);
    assert_err(env.settle(&m), MeridianError::TickerDayNotFinal);
}

#[test]
fn set_10_cannot_settle_from_provisional_or_disputed() {
    let (mut env, m, _) = setup();
    env.warp(CLOSE + 300);
    env.record_close(&Update::meta(px(68_500), 1)).unwrap();
    assert_err(env.settle(&m), MeridianError::TickerDayNotFinal);
    let eve = env.user(100 * USDC);
    env.raise_dispute(&eve).unwrap();
    assert_err(env.settle(&m), MeridianError::TickerDayNotFinal);
    assert_eq!(env.market(&m).outcome, Outcome::None);
}
