//! MER-15 · pause and unpause scope (D30).
//! Matrix: PSE-01 .. PSE-05. Phase 2 adds the order halves (place_order, buy_no_*,
//! sell_no blocked; cancel_order, cancel_all, withdraw allowed; place_order restored).
//! The settle, redeem and prune halves of PSE-03 land with MER-31 to MER-35.
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

#[test]
fn pse_01_pause_blocks_new_orders_and_every_trade_path() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user_with_yes(&m, 100 * USDC, 10);
    let admin = env.admin.insecure_clone();
    env.set_paused(&admin, true).unwrap();
    for t in [
        TradeIx::Place {
            side: Side::Bid,
            price: 40,
            qty: 1,
            tif: TimeInForce::Gtc,
        },
        TradeIx::Place {
            side: Side::Ask,
            price: 60,
            qty: 1,
            tif: TimeInForce::Ioc,
        },
        TradeIx::BuyNoMarket { qty: 1, min_yes: 1 },
        TradeIx::BuyNoLimit {
            qty: 1,
            yes_price: 60,
        },
        TradeIx::SellNo {
            qty: 1,
            max_yes: 99,
        },
    ] {
        assert_err(env.trade(&alice, &m, t), MeridianError::Paused);
    }
}

#[test]
fn pse_02_pause_leaves_cancel_and_withdraw_open() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user_with_yes(&m, 100 * USDC, 10);
    let bob = env.user(100 * USDC);
    env.ask(&alice, &m, 60, 4, TimeInForce::Gtc).unwrap();
    env.ask(&alice, &m, 61, 4, TimeInForce::Gtc).unwrap();
    env.bid(&bob, &m, 60, 2, TimeInForce::Ioc).unwrap();
    let admin = env.admin.insecure_clone();
    env.set_paused(&admin, true).unwrap();
    let id = env.book(&m).level(Side::Ask, 60)[0].1;
    env.cancel(&alice, &m, id).unwrap();
    env.cancel_all(&alice, &m).unwrap();
    env.withdraw(&alice, &m).unwrap();
    env.withdraw(&bob, &m).unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (100 * USDC + 2 * 60 * 10_000, 8, 10)
    );
    assert_eq!(env.balances(&bob.pubkey(), &m).1, 2);
}

#[test]
fn pse_04_unpause_restores_orders() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(100 * USDC);
    let admin = env.admin.insecure_clone();
    env.set_paused(&admin, true).unwrap();
    assert_err(
        env.bid(&alice, &m, 40, 1, TimeInForce::Gtc),
        MeridianError::Paused,
    );
    env.set_paused(&admin, false).unwrap();
    env.bid(&alice, &m, 40, 1, TimeInForce::Gtc).unwrap();
}
