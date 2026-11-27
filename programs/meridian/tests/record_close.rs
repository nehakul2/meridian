//! MER-31 · record_close: official close (D3) cross-checked against a Pyth update
//! stamped in [close_time, close_time + settle_window_s] (D1, D2, D13, D27).
//! Matrix: ORC-01 to ORC-16, ORC-19, SEC-02. The status the matrix calls RECORDED is
//! PROVISIONAL on-chain (D8: the dispute window follows every record).
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::CloseRecorded,
    instructions::ConfigUpdate,
    state::{CloseSource, CloseSourceMode, TickerDayStatus},
};
use solana_sdk::signature::Signer;

fn setup() -> Env {
    let (mut env, _) = Env::with_market();
    env.warp(CLOSE + 300);
    env
}

fn td() -> solana_sdk::pubkey::Pubkey {
    ticker_day_pda("META", DATE)
}

fn assert_open(env: &Env) {
    let t = env.ticker_day(&td());
    assert_eq!(t.status, TickerDayStatus::Open);
    assert_eq!(t.price, 0);
}

#[test]
fn orc_01_accepts_update_published_at_close_time() {
    let mut env = setup();
    let u = Update::meta(px(68_500), 3);
    let meta = env.record_close(&u).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(t.status, TickerDayStatus::Provisional);
    assert_eq!((t.price, t.expo), (px(68_500), EXPO));
    assert_eq!(
        (t.ref_price, t.ref_conf, t.ref_publish_time),
        (u.price, u.conf, CLOSE)
    );
    assert_eq!(t.recorded_at, CLOSE + 300);
    assert_eq!(t.recorded_by, env.settler.pubkey());
    let ev = &events::<CloseRecorded>(&meta)[0];
    assert_eq!(
        (ev.price, ev.expo, ev.conf, ev.publish_time),
        (u.price, EXPO, u.conf, CLOSE)
    );
    assert_eq!((ev.market, ev.seq, ev.r#override), (td(), 0, false));
    assert_eq!(ev.by, env.settler.pubkey());
}

#[test]
fn orc_02_accepts_close_plus_epsilon() {
    let mut env = setup();
    env.record_close(&Update::meta(px(68_500), 3).at(CLOSE + 5))
        .unwrap();
    assert_eq!(env.ticker_day(&td()).ref_publish_time, CLOSE + 5);
}

#[test]
fn orc_03_rejects_update_before_close() {
    let mut env = setup();
    assert_err(
        env.record_close(&Update::meta(px(68_500), 3).at(CLOSE - 1)),
        MeridianError::PublishTimeOutsideWindow,
    );
    assert_open(&env);
}

#[test]
fn orc_04_rejects_after_hours_updates() {
    let mut env = setup();
    for t in [CLOSE + 6, CLOSE + 270] {
        assert_err(
            env.record_close(&Update::meta(px(68_500), 3).at(t)),
            MeridianError::PublishTimeOutsideWindow,
        );
    }
    assert_open(&env);
}

#[test]
fn orc_05_rejects_wide_confidence() {
    let mut env = setup();
    assert_err(
        env.record_close(&Update::meta(px(68_500), 11).at(CLOSE + 1)),
        MeridianError::ConfidenceTooWide,
    );
    assert_open(&env);
}

#[test]
fn orc_06_confidence_at_threshold_accepted() {
    let mut env = setup();
    // 68,000,000 x 10 bps = 68,000 exactly.
    let u = Update::meta(px(68_000), 10);
    assert_eq!(u.conf, 68_000);
    env.record_close(&u).unwrap();
}

#[test]
fn orc_07_wrong_feed_id_rejected() {
    let mut env = setup();
    let mut u = Update::meta(px(68_500), 3);
    u.feed_id = feed_id(0); // AAPL
    assert_err(env.record_close(&u), MeridianError::FeedMismatch);
    assert_open(&env);
}

#[test]
fn orc_08_partially_verified_update_rejected() {
    let mut env = setup();
    for n in [0u8, 1, 12, 255] {
        let mut u = Update::meta(px(68_500), 3);
        u.partial = Some(n);
        assert_err(env.record_close(&u), MeridianError::OracleNotFullyVerified);
    }
    assert_open(&env);
}

#[test]
fn sec_02_fake_oracle_account_fails_owner_check() {
    let mut env = setup();
    let mut u = Update::meta(px(68_500), 3);
    u.owner = solana_sdk::pubkey::Pubkey::new_unique(); // attacker program, same bytes
    assert_err(env.record_close(&u), MeridianError::InvalidOracleAccount);
    // Right owner, wrong account type (discriminator).
    let addr = env.put_update(&Update::meta(px(68_500), 3));
    let mut acc = env.svm.get_account(&addr).unwrap();
    acc.data[0] ^= 0xFF;
    env.svm.set_account(addr, acc).unwrap();
    let s = env.settler.insecure_clone();
    let ix = env.ix_record_close(
        &s.pubkey(),
        &td(),
        &addr,
        Some(OfficialClose {
            price: px(68_500),
            expo: EXPO,
        }),
    );
    assert_err(env.send(&[ix], &[&s]), MeridianError::InvalidOracleAccount);
    assert_open(&env);
}

#[test]
fn orc_09_only_settler_can_record() {
    let mut env = setup();
    let eve = env.user(100 * USDC);
    let admin = env.admin.insecure_clone();
    let creator = env.creator.insecure_clone();
    let u = Update::meta(px(68_500), 3);
    for k in [&eve, &admin, &creator] {
        assert_err(
            env.record_close_as(k, &u, Some(u.price)),
            MeridianError::Unauthorized,
        );
    }
    assert_open(&env);
}

#[test]
fn orc_10_price_selection_attack_blocked() {
    let mut env = setup();
    let (_, m) = (0, market_pda("META", DATE, STRIKE_680));
    let eve = env.user(100 * USDC);
    let u = Update::meta(px(67_900), 3).at(CLOSE - 180); // the 15:57 update
    assert_err(
        env.record_close_as(&eve, &u, Some(u.price)),
        MeridianError::Unauthorized,
    );
    assert_err(env.settle_as(&eve, &m), MeridianError::TickerDayNotFinal);
    assert_open(&env);
}

#[test]
fn orc_11_close_is_recorded_once_and_immutable() {
    let mut env = setup();
    env.record_close(&Update::meta(px(68_500), 3)).unwrap();
    assert_err(
        env.record_close(&Update::meta(px(69_000), 3).at(CLOSE + 2)),
        MeridianError::TickerDayNotOpen,
    );
    env.warp(CLOSE + 1_800);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.admin_settle_as(&admin, px(70_000)),
        MeridianError::TickerDayNotOpen,
    );
    assert_eq!(env.ticker_day(&td()).price, px(68_500));
}

#[test]
fn orc_12_rejected_before_close_time() {
    let mut env = setup();
    env.warp(CLOSE - 10);
    assert_err(
        env.record_close(&Update::meta(px(68_500), 3)),
        MeridianError::CloseNotReached,
    );
    assert_open(&env);
}

#[test]
fn orc_13_staleness_is_relative_to_close_not_wall_clock() {
    let mut env = setup();
    env.warp(CLOSE + 14 * 60);
    env.record_close(&Update::meta(px(68_500), 3).at(CLOSE + 2))
        .unwrap();
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Provisional);
}

#[test]
fn orc_14_negative_or_zero_price_rejected() {
    let mut env = setup();
    for p in [0i64, -68_500_000] {
        let mut u = Update::meta(px(68_500), 3);
        u.price = p;
        u.conf = 0;
        assert_err(
            env.record_close_as(&env.settler.insecure_clone(), &u, Some(px(68_500))),
            MeridianError::InvalidOraclePrice,
        );
    }
    // A non-positive attested value is refused too.
    let u = Update::meta(px(68_500), 3);
    assert_err(
        env.record_close_as(&env.settler.insecure_clone(), &u, Some(0)),
        MeridianError::InvalidOraclePrice,
    );
    assert_open(&env);
}

#[test]
fn orc_15_records_the_official_close_not_the_reference_tick() {
    let mut env = setup();
    let mut u = Update::meta(68_498_000, 3).at(CLOSE + 1);
    u.conf = 20_549; // 3 bps
    let s = env.settler.insecure_clone();
    env.record_close_as(&s, &u, Some(68_512_000)).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(t.price, 68_512_000, "685.12 official");
    assert_eq!(t.ref_price, 68_498_000, "684.98 reference");
    assert_eq!(t.close_source, CloseSource::AttestedChecked);
}

#[test]
fn orc_16_official_close_outside_tolerance_rejected() {
    let mut env = setup();
    let mut u = Update::meta(68_498_000, 3).at(CLOSE + 1);
    u.conf = 20_549;
    let s = env.settler.insecure_clone();
    assert_err(
        env.record_close_as(&s, &u, Some(69_000_000)),
        MeridianError::CrossCheckFailed,
    );
    // Exactly at 20 bps of the reference is accepted: 68,498,000 x 0.002 = 136,996.
    env.record_close_as(&s, &u, Some(68_498_000 + 136_996))
        .unwrap();
}

#[test]
fn official_close_needs_matching_expo_and_attested_value() {
    let mut env = setup();
    let s = env.settler.insecure_clone();
    let u = Update::meta(px(68_500), 3);
    assert_err(
        env.record_close_as(&s, &u, None),
        MeridianError::OfficialCloseRequired,
    );
    let addr = env.put_update(&u);
    let ix = env.ix_record_close(
        &s.pubkey(),
        &td(),
        &addr,
        Some(OfficialClose {
            price: 68_500,
            expo: -2,
        }),
    );
    assert_err(env.send(&[ix], &[&s]), MeridianError::ExpoMismatch);
    assert_open(&env);
}

#[test]
fn orc_19_oracle_official_mode_reads_the_feed() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    env.update_config(
        &admin,
        ConfigUpdate {
            close_source_mode: Some(CloseSourceMode::OracleOfficial),
            ..Default::default()
        },
    )
    .unwrap();
    let s = env.settler.insecure_clone();
    let u = Update::meta(px(68_512), 2);
    assert_err(
        env.record_close_as(&s, &u, Some(u.price)),
        MeridianError::OfficialCloseNotAllowed,
    );
    env.record_close_as(&s, &u, None).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(t.close_source, CloseSource::OracleOfficial);
    assert_eq!(t.price, px(68_512));
}

#[test]
fn retry_with_the_same_update_gives_the_same_result() {
    // D2: a failed submission changes nothing; resubmitting the same official close and
    // the same update bytes records exactly those values.
    let mut env = setup();
    let u = Update::meta(px(68_500), 3);
    env.warp(CLOSE - 1);
    assert_err(env.record_close(&u), MeridianError::CloseNotReached);
    assert_open(&env);
    env.warp(CLOSE + 330);
    env.record_close(&u).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.price, t.ref_conf, t.ref_publish_time),
        (u.price, u.conf, u.publish_time)
    );
    // A duplicate landing after success fails cleanly and changes nothing.
    assert_err(env.record_close(&u), MeridianError::TickerDayNotOpen);
    assert_eq!(env.ticker_day(&td()).recorded_at, t.recorded_at);
}

#[test]
fn cal_09_record_close_decides_by_chain_clock() {
    // Wall clock 16:00:30 while the chain says 15:59:59: rejected; accepted once the
    // chain clock reaches close_time.
    let mut env = setup();
    let u = Update::meta(px(68_500), 3);
    env.warp(CLOSE - 1);
    assert_err(env.record_close(&u), MeridianError::CloseNotReached);
    env.warp(CLOSE);
    env.record_close(&u).unwrap();
}
