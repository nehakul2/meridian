//! MER-21 · cancel_order, cancel_all, UserLedger and withdraw.
//! Matrix: BOOK-10, BOOK-11, BOOK-12, HLT-03, SEC-03.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{CancelReason, OrderCancelled, Withdrawn},
};
use solana_sdk::signature::Signer;
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

fn open() -> (Env, solana_sdk::pubkey::Pubkey) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    (env, m)
}

#[test]
fn book_10_maker_proceeds_go_to_ledger_and_are_withdrawable() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    env.bid(&alice, &m, 60, 10, Ioc).unwrap();
    let l = env.ledger(&m, &bob.pubkey());
    assert_eq!(
        (l.free_usdc, l.locked_yes, l.open_order_count),
        (10 * 60 * C, 0, 0)
    );
    let before = env.balances(&bob.pubkey(), &m).0;
    let meta = env.withdraw(&bob, &m).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m).0, before + 10 * 60 * C);
    let l = env.ledger(&m, &bob.pubkey());
    assert_eq!((l.free_usdc, l.free_yes), (0, 0));
    let ev = events::<Withdrawn>(&meta);
    assert_eq!((ev[0].usdc, ev[0].yes), (10 * 60 * C, 0));
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn book_11_cancel_returns_locked_funds_owner_only() {
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    let eve = env.user(100 * USDC);
    env.bid(&alice, &m, 40, 10, Gtc).unwrap();
    let id = env.book(&m).level(Side::Bid, 40)[0].1;
    // eve tries first (she has a ledger of her own, from an order elsewhere).
    env.bid(&eve, &m, 10, 1, Gtc).unwrap();
    assert_err(env.cancel(&eve, &m, id), MeridianError::Unauthorized);
    let meta = env.cancel(&alice, &m, id).unwrap();
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!(
        (l.locked_usdc, l.free_usdc, l.open_order_count),
        (0, 10 * 40 * C, 0)
    );
    let ev = events::<OrderCancelled>(&meta);
    assert_eq!(
        (ev[0].order_id, ev[0].reason, ev[0].qty),
        (id, CancelReason::User, 10)
    );
    assert!(env.book(&m).level(Side::Bid, 40).is_empty());
    assert_err(env.cancel(&alice, &m, id), MeridianError::OrderNotFound);
    env.assert_book_escrow(&m, &[alice.pubkey(), eve.pubkey()]);
}

#[test]
fn book_12_cancel_all_cancels_only_the_callers_orders() {
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 1_000 * USDC, 10);
    let bob = env.user(1_000 * USDC);
    env.bid(&alice, &m, 30, 1, Gtc).unwrap();
    env.bid(&alice, &m, 31, 1, Gtc).unwrap();
    env.ask(&alice, &m, 80, 5, Gtc).unwrap();
    env.bid(&bob, &m, 30, 1, Gtc).unwrap();
    env.bid(&bob, &m, 32, 1, Gtc).unwrap();
    let meta = env.cancel_all(&alice, &m).unwrap();
    assert_eq!(events::<OrderCancelled>(&meta).len(), 3);
    let v = env.book(&m);
    assert!(v.get().orders_of(&alice.pubkey()).is_empty());
    assert_eq!(v.get().orders_of(&bob.pubkey()).len(), 2);
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.open_order_count, l.locked_usdc, l.locked_yes), (0, 0, 0));
    assert_eq!((l.free_usdc, l.free_yes), (61 * C, 5));
    env.withdraw(&alice, &m).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (1_000 * USDC, 10, 10));
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn hlt_03_cancel_still_works_after_close() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    env.ask(&bob, &m, 40, 10, Gtc).unwrap();
    let id = env.book(&m).level(Side::Ask, 40)[0].1;
    env.warp(CLOSE + 120);
    env.cancel(&bob, &m, id).unwrap();
    assert_eq!(env.ledger(&m, &bob.pubkey()).free_yes, 10);
    env.withdraw(&bob, &m).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m).1, 10);
}

#[test]
fn sec_03_cannot_withdraw_another_users_ledger() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    let eve = env.user(100 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    env.bid(&alice, &m, 60, 10, Ioc).unwrap();
    let ix = env.ix_withdraw(&eve.pubkey(), &m, ledger_pda(&m, &bob.pubkey()));
    assert_fails(env.send(&[ix], &[&eve]));
    assert_eq!(env.ledger(&m, &bob.pubkey()).free_usdc, 10 * 60 * C);
    assert_eq!(env.balances(&eve.pubkey(), &m).0, 100 * USDC);
}

#[test]
fn locked_balances_are_not_withdrawable() {
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    env.bid(&alice, &m, 40, 10, Gtc).unwrap();
    let meta = env.withdraw(&alice, &m).unwrap();
    assert_eq!(events::<Withdrawn>(&meta)[0].usdc, 0);
    assert_eq!(env.ledger(&m, &alice.pubkey()).locked_usdc, 10 * 40 * C);
    assert_eq!(
        env.balances(&alice.pubkey(), &m).0,
        1_000 * USDC - 10 * 40 * C
    );
}
