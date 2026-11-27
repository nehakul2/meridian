//! MER-33 · admin_settle override with the 30-minute delay (D4, D19, A22), and the admin
//! path for a strike refused by the confidence check (ADM-07, D27).
//! Matrix: ADM-01 to ADM-05, ADM-07, CON-06.
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::CloseRecorded,
    state::{CloseSource, MarketStatus, Outcome, TickerDayStatus},
};
use solana_sdk::{pubkey::Pubkey, signature::Signer};

const DELAY: i64 = 1_800;

fn setup() -> (Env, Pubkey) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m, 10).unwrap();
    (env, m)
}

fn td() -> Pubkey {
    ticker_day_pda("META", DATE)
}

#[test]
fn adm_01_override_before_delay_fails() {
    let (mut env, _) = setup();
    env.warp(CLOSE + DELAY - 1);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_as(&admin, 68_512_000),
        MeridianError::OverrideTooEarly,
    );
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Open);
}

#[test]
fn adm_02_override_at_delay_succeeds_and_skips_the_band_check() {
    let (mut env, m) = setup();
    env.warp(CLOSE + DELAY);
    let admin = env.admin.insecure_clone();
    // 680.002: inside any plausible confidence band of strike 680, but an admin price
    // carries no band.
    let meta = env.admin_settle_as(&admin, 68_000_200).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        t.status,
        TickerDayStatus::Provisional,
        "goes through the dispute window (D8)"
    );
    assert_eq!((t.close_source, t.price), (CloseSource::Admin, 68_000_200));
    let ev = &events::<CloseRecorded>(&meta)[0];
    assert!(ev.r#override);
    assert_eq!((ev.by, ev.price), (admin.pubkey(), 68_000_200));
    env.warp(CLOSE + DELAY + 1_200);
    env.finalize_close().unwrap();
    env.settle(&m).unwrap();
    assert_eq!(env.market(&m).outcome, Outcome::Yes);
    assert_eq!(env.market(&m).settle_price, 68_000_200);
}

#[test]
fn adm_03_override_after_oracle_record_fails() {
    let (mut env, _) = setup();
    env.warp(CLOSE + 300);
    env.record_close(&Update::meta(px(68_500), 1)).unwrap();
    env.warp(CLOSE + DELAY);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_as(&admin, px(69_000)),
        MeridianError::TickerDayNotOpen,
    );
    assert_eq!(env.ticker_day(&td()).price, px(68_500));
}

#[test]
fn adm_04_first_writer_wins_on_race() {
    // Both transactions built against the same OPEN state, landing in one slot.
    let (mut base, _) = setup();
    base.warp(CLOSE + DELAY);
    let u = Update::meta(px(68_500), 1);
    let upd = base.put_update(&u);
    let settler = base.settler.insecure_clone();
    let admin = base.admin.insecure_clone();
    let rec = base.ix_record_close(
        &settler.pubkey(),
        &td(),
        &upd,
        Some(OfficialClose {
            price: u.price,
            expo: EXPO,
        }),
    );
    let ovr = base.ix_admin_settle(&admin.pubkey(), &td(), px(70_000), EXPO);

    let mut env = base.fork();
    env.send(std::slice::from_ref(&rec), &[&settler]).unwrap();
    assert_err(
        env.send(std::slice::from_ref(&ovr), &[&admin]),
        MeridianError::TickerDayNotOpen,
    );
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.close_source, t.price),
        (CloseSource::AttestedChecked, px(68_500))
    );

    let mut env = base.fork();
    env.send(&[ovr], &[&admin]).unwrap();
    assert_err(
        env.send(&[rec], &[&settler]),
        MeridianError::TickerDayNotOpen,
    );
    let t = env.ticker_day(&td());
    assert_eq!((t.close_source, t.price), (CloseSource::Admin, px(70_000)));
}

#[test]
fn adm_05_only_admin_can_override() {
    let (mut env, _) = setup();
    env.warp(CLOSE + DELAY);
    let eve = env.user(0);
    let settler = env.settler.insecure_clone();
    let creator = env.creator.insecure_clone();
    for k in [&settler, &creator, &eve] {
        assert_err(
            env.admin_settle_as(k, px(68_500)),
            MeridianError::Unauthorized,
        );
    }
}

#[test]
fn override_price_is_validated() {
    let (mut env, _) = setup();
    env.warp(CLOSE + DELAY);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_as(&admin, 0),
        MeridianError::InvalidOraclePrice,
    );
    let ix = env.ix_admin_settle(&admin.pubkey(), &td(), 68_500, 40);
    assert_err(env.send(&[ix], &[&admin]), MeridianError::InvalidExpo);
}

/// SET-06 state: 680.20 +/- 0.30 recorded and final; M680 refused, M700 fine.
fn refused_strike() -> (Env, Pubkey, Pubkey) {
    let (mut env, m680) = setup();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let mut u = Update::meta(68_020_000, 0);
    u.conf = 30_000;
    env.close_with(u);
    assert_err(env.settle(&m680), MeridianError::ConfidenceStraddle);
    (env, m680, m700)
}

#[test]
fn adm_07_refused_strike_resolves_via_admin_path() {
    let (mut env, m680, m700) = refused_strike();
    env.settle(&m700).unwrap();
    let admin = env.admin.insecure_clone();
    // Only the admin multisig.
    let eve = env.user(0);
    let settler = env.settler.insecure_clone();
    for k in [&eve, &settler] {
        assert_err(
            env.admin_settle_market_as(k, &m680, Outcome::Yes),
            MeridianError::Unauthorized,
        );
    }
    // Only YES or NO.
    assert_err(
        env.admin_settle_market_as(&admin, &m680, Outcome::Void),
        MeridianError::InvalidConfig,
    );
    env.admin_settle_market_as(&admin, &m680, Outcome::Yes)
        .unwrap();
    let mk = env.market(&m680);
    assert_eq!(
        (mk.status, mk.outcome),
        (MarketStatus::Settled, Outcome::Yes)
    );
    assert_eq!(mk.settle_price, 68_020_000, "same ticker-day price (D11)");
    assert_eq!(mk.collateral_accounted, 10 * USDC);
    // The other strike is untouched; a repeat is a no-op.
    assert_eq!(env.market(&m700).outcome, Outcome::No);
    env.admin_settle_market_as(&admin, &m680, Outcome::No)
        .unwrap();
    assert_eq!(env.market(&m680).outcome, Outcome::Yes, "outcome immutable");
}

#[test]
fn adm_07_admin_path_refused_for_a_strike_outside_the_band() {
    let (mut env, _, m700) = refused_strike();
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_market_as(&admin, &m700, Outcome::Yes),
        MeridianError::NotInConfidenceBand,
    );
    assert_eq!(env.market(&m700).outcome, Outcome::None);
}

#[test]
fn adm_07_admin_path_needs_a_final_price() {
    let (mut env, m) = setup();
    env.warp(CLOSE + 300);
    let mut u = Update::meta(68_020_000, 0);
    u.conf = 30_000;
    env.record_close(&u).unwrap();
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_market_as(&admin, &m, Outcome::Yes),
        MeridianError::TickerDayNotFinal,
    );
}
