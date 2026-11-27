//! MER-15 · pause and unpause scope (D30).
//! Matrix: PSE-01 .. PSE-05. Order, cancel, withdraw, settle, redeem and prune
//! halves of PSE-01..04 are added to this file as those instructions land
//! (MER-20 to MER-35).
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::{Paused, Unpaused},
};
use solana_sdk::signature::Signer;

#[test]
fn pse_01_pause_blocks_mint() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    let admin = env.admin.insecure_clone();
    env.warp(OPEN);
    let meta = env.set_paused(&admin, true).unwrap();
    assert!(env.config().paused);
    let ev = events::<Paused>(&meta);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].by, ev[0].market, ev[0].seq),
        (admin.pubkey(), config_pda(), 0)
    );
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::Paused);
}

#[test]
fn pse_02_pause_leaves_merge_open() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    let admin = env.admin.insecure_clone();
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 5).unwrap();
    env.set_paused(&admin, true).unwrap();
    env.merge_pair(&bob, &m, 5).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m), (100 * USDC, 0, 0));
}

#[test]
fn pse_03_pause_does_not_block_market_creation_or_ticker_days() {
    // Automation keeps creating markets and settlement keeps running while paused (R5.7).
    // record_close / settle_market / redeem / prune_orders assertions arrive with MER-31..35.
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    env.set_paused(&admin, true).unwrap();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    env.create_market("META", DATE, STRIKE_680).unwrap();
    env.add_strike("META", DATE, 69_000).unwrap();
}

#[test]
fn pse_04_unpause_restores_minting() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    let admin = env.admin.insecure_clone();
    env.warp(OPEN);
    env.set_paused(&admin, true).unwrap();
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::Paused);
    let meta = env.set_paused(&admin, false).unwrap();
    assert_eq!(events::<Unpaused>(&meta).len(), 1);
    assert!(!env.config().paused);
    env.mint_pair(&bob, &m, 1).unwrap();
}

#[test]
fn pse_05_only_admin_can_pause() {
    let mut env = Env::new();
    let eve = env.user(0);
    let creator = env.creator.insecure_clone();
    let settler = env.settler.insecure_clone();
    for k in [&creator, &settler, &eve] {
        assert_err(env.set_paused(k, true), MeridianError::Unauthorized);
    }
    assert!(!env.config().paused);
    let admin = env.admin.insecure_clone();
    env.set_paused(&admin, true).unwrap();
    for k in [&creator, &settler, &eve] {
        assert_err(env.set_paused(k, false), MeridianError::Unauthorized);
    }
    assert!(env.config().paused);
}
