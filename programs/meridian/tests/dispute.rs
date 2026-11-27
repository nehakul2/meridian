//! MER-37 · dispute window: raise_dispute, resolve_dispute, finalize_close (D8, spec 4.8).
//! Matrix: DSP-01 to DSP-07 (DSP-08 is the Settlement Triage agent, Phase 9).
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::{CloseFinalized, DisputeRaised, DisputeResolved, DisputeResult},
    instructions::ConfigUpdate,
    state::{Dispute, FinalBasis, Outcome, TickerDayStatus},
};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

const WINDOW: i64 = 1_200;
const DAY: i64 = 86_400;
const BOND: u64 = 100 * USDC;
/// 16:02:00.
const RECORDED: i64 = CLOSE + 120;

fn td() -> Pubkey {
    ticker_day_pda("META", DATE)
}

/// META (M680, M685) recorded PROVISIONAL at 16:02:00 at `price`; bob holds 10 pairs of M680; eve
/// has exactly one bond.
fn provisional(price: i64) -> (Env, Pubkey, Keypair) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    // M685, for the strike a correction lands on (DSP-05).
    env.create_market("META", DATE, 68_500).unwrap();
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m, 10).unwrap();
    env.warp(RECORDED);
    env.record_close(&Update::meta(price, 1)).unwrap();
    let eve = env.user(BOND);
    (env, m, eve)
}

fn disputed(price: i64) -> (Env, Pubkey, Keypair) {
    let (mut env, m, eve) = provisional(price);
    env.warp(RECORDED + 60);
    env.raise_dispute(&eve).unwrap();
    (env, m, eve)
}

#[test]
fn dsp_01_undisputed_price_finalizes_after_the_window() {
    let (mut env, _, _) = provisional(px(68_500));
    env.warp(RECORDED + WINDOW - 1); // 16:21:59
    assert_err(env.finalize_close(), MeridianError::DisputeWindowOpen);
    env.warp(RECORDED + WINDOW); // 16:22:00
    let meta = env.finalize_close().unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.status, t.final_basis),
        (TickerDayStatus::Final, FinalBasis::Undisputed)
    );
    assert_eq!(t.finalized_at, RECORDED + WINDOW);
    assert_eq!(t.recorded_at, RECORDED, "provisional time kept apart (D18)");
    let ev = &events::<CloseFinalized>(&meta)[0];
    assert_eq!(
        (ev.price, ev.basis, ev.market),
        (px(68_500), FinalBasis::Undisputed, td())
    );
    // FINAL is final.
    assert_err(env.finalize_close(), MeridianError::TickerDayNotOpen);
}

#[test]
fn dsp_02_dispute_takes_the_bond_and_blocks_finalization() {
    let (mut env, m, eve) = provisional(px(68_500));
    let vault_before = env.token_balance(&env.market(&m).vault);
    env.warp(RECORDED + 60);
    let meta = env.raise_dispute(&eve).unwrap();
    let bv = env.config().bond_vault;
    assert_eq!(env.token_balance(&bv), BOND);
    assert_eq!(env.usdc_of(&eve.pubkey()), 0);
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Disputed);
    let ev = &events::<DisputeRaised>(&meta)[0];
    assert_eq!(
        (ev.by, ev.bond, ev.evidence_hash),
        (eve.pubkey(), BOND, [9u8; 32])
    );
    let d: Dispute = env.fetch(&dispute_pda(&td()));
    assert_eq!(
        (d.disputer, d.bond, d.raised_at),
        (eve.pubkey(), BOND, RECORDED + 60)
    );
    // Finalize fails, even after the window.
    env.warp(RECORDED + WINDOW + 5);
    assert_err(
        env.finalize_close(),
        MeridianError::ResolutionDeadlineNotReached,
    );
    // A second dispute fails (one per ticker-day).
    env.warp(RECORDED + 120);
    let carol = env.user(BOND);
    assert_fails(env.raise_dispute(&carol));
    assert_eq!(env.usdc_of(&carol.pubkey()), BOND);
    // Bonds never touch the collateral vault.
    assert_eq!(env.token_balance(&env.market(&m).vault), vault_before);
}

#[test]
fn dsp_03_dispute_after_the_window_is_rejected() {
    let (mut env, _, eve) = provisional(px(68_500));
    env.warp(RECORDED + WINDOW);
    assert_err(env.raise_dispute(&eve), MeridianError::DisputeWindowClosed);
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Provisional);
    assert_eq!(env.usdc_of(&eve.pubkey()), BOND);
    // The last second inside the window is accepted.
    let mut env2 = provisional(px(68_500)).0;
    env2.warp(RECORDED + WINDOW - 1);
    let e2 = env2.user(BOND);
    env2.raise_dispute(&e2).unwrap();
}

#[test]
fn dispute_needs_a_provisional_close() {
    let (mut env, _) = Env::with_market();
    env.warp(CLOSE + 60);
    let eve = env.user(BOND);
    assert_err(env.raise_dispute(&eve), MeridianError::NotProvisional);
}

#[test]
fn dsp_04_uphold_keeps_price_and_bond_goes_to_fee_vault() {
    let (mut env, m, eve) = disputed(px(68_500));
    let admin = env.admin.insecure_clone();
    let meta = env.resolve_dispute_as(&admin, Resolution::Uphold).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.status, t.final_basis, t.price),
        (TickerDayStatus::Final, FinalBasis::Upheld, px(68_500))
    );
    assert_eq!(env.token_balance(&env.fee_vault.clone()), BOND);
    assert_eq!(env.token_balance(&env.config().bond_vault), 0);
    assert_eq!(env.usdc_of(&eve.pubkey()), 0);
    let ev = &events::<DisputeResolved>(&meta)[0];
    assert_eq!(
        (ev.result, ev.old_price, ev.new_price),
        (DisputeResult::Upheld, px(68_500), px(68_500))
    );
    assert_eq!(events::<CloseFinalized>(&meta)[0].basis, FinalBasis::Upheld);
    env.settle(&m).unwrap();
    assert_eq!(env.market(&m).settle_price, px(68_500));
}

#[test]
fn dsp_05_correct_replaces_price_once_and_returns_the_bond() {
    let (mut env, _, eve) = disputed(px(68_400));
    let m685 = market_pda("META", DATE, 68_500);
    env.warp(RECORDED + 600);
    let admin = env.admin.insecure_clone();
    let fix = Resolution::Correct {
        price: 68_512_000,
        expo: EXPO,
    };
    let meta = env.resolve_dispute_as(&admin, fix).unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.status, t.final_basis),
        (TickerDayStatus::Final, FinalBasis::Corrected)
    );
    assert_eq!((t.original_price, t.price), (px(68_400), 68_512_000));
    assert_eq!(env.usdc_of(&eve.pubkey()), BOND, "bond back");
    assert_eq!(env.token_balance(&env.config().bond_vault), 0);
    let ev = &events::<DisputeResolved>(&meta)[0];
    assert_eq!(
        (ev.result, ev.old_price, ev.new_price),
        (DisputeResult::Corrected, px(68_400), 68_512_000)
    );
    env.settle(&m685).unwrap();
    assert_eq!(env.market(&m685).outcome, Outcome::Yes);
    assert_err(
        env.resolve_dispute_as(&admin, fix),
        MeridianError::NotDisputed,
    );
    assert_err(
        env.resolve_dispute_as(&admin, Resolution::Uphold),
        MeridianError::NotDisputed,
    );
}

#[test]
fn dsp_06_deadline_recorded_price_stands_and_bond_returned() {
    let (mut env, _, eve) = disputed(px(68_500));
    let raised = RECORDED + 60;
    env.warp(raised + DAY - 1);
    assert_err(
        env.finalize_close(),
        MeridianError::ResolutionDeadlineNotReached,
    );
    env.warp(raised + DAY);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.resolve_dispute_as(&admin, Resolution::Uphold),
        MeridianError::ResolutionDeadlinePassed,
    );
    let meta = env.finalize_close().unwrap();
    let t = env.ticker_day(&td());
    assert_eq!(
        (t.status, t.final_basis, t.price),
        (TickerDayStatus::Final, FinalBasis::Deadline, px(68_500))
    );
    assert_eq!(env.usdc_of(&eve.pubkey()), BOND);
    assert_eq!(
        events::<CloseFinalized>(&meta)[0].basis,
        FinalBasis::Deadline
    );
}

#[test]
fn dsp_06_deadline_refund_only_to_the_disputer() {
    let (mut env, _, _) = disputed(px(68_500));
    env.warp(RECORDED + 60 + DAY);
    let mallory = env.user(0);
    let mut ix = env.ix_finalize_close(&td());
    // Swap the refund account for mallory's.
    let theirs = ata(&mallory.pubkey(), &env.usdc_mint);
    let pos = ix.accounts.len() - 4; // disputer_usdc precedes token_program, event_authority, program
    ix.accounts[pos].pubkey = theirs;
    let p = env.payer.insecure_clone();
    assert_err(env.send(&[ix], &[&p]), MeridianError::AccountMismatch);
}

#[test]
fn dsp_07_only_admin_resolves_anyone_finalizes() {
    let (mut env, _, _) = disputed(px(68_500));
    let settler = env.settler.insecure_clone();
    let eve = env.user(0);
    for k in [&settler, &eve] {
        assert_err(
            env.resolve_dispute_as(k, Resolution::Uphold),
            MeridianError::Unauthorized,
        );
    }
    let (mut env, _, _) = provisional(px(68_500));
    env.warp(RECORDED + WINDOW);
    let eve = env.user(0);
    env.finalize_close_as(&eve).unwrap();
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Final);
}

#[test]
fn admin_override_price_goes_through_the_window_too() {
    let (mut env, _) = Env::with_market();
    env.warp(CLOSE + 1_800);
    let admin = env.admin.insecure_clone();
    env.admin_settle_as(&admin, px(68_500)).unwrap();
    assert_err(env.finalize_close(), MeridianError::DisputeWindowOpen);
    let eve = env.user(BOND);
    env.raise_dispute(&eve).unwrap();
    assert_eq!(env.ticker_day(&td()).status, TickerDayStatus::Disputed);
}

#[test]
fn bond_vault_must_belong_to_the_bond_authority() {
    let (mut env, _, eve) = provisional(px(68_500));
    let rogue = Pubkey::new_unique();
    let usdc = env.usdc_mint;
    env.put_token_account(rogue, usdc, eve.pubkey(), 0);
    let admin = env.admin.insecure_clone();
    env.update_config(
        &admin,
        ConfigUpdate {
            bond_vault: Some(rogue),
            ..Default::default()
        },
    )
    .unwrap();
    env.warp(RECORDED + 60);
    assert_err(env.raise_dispute(&eve), MeridianError::InvalidBondVault);
}
