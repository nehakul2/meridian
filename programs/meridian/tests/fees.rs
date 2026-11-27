//! MER-25 · taker fee to a separate fee vault.
//! Matrix: CFG-06.
mod common;

use common::*;
use meridian::{
    book::taker_fee,
    constants::*,
    events::{FeesSwept, Fill},
    instructions::ConfigUpdate,
};
use solana_sdk::signature::Signer;
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

fn with_fee(bps: u16) -> (Env, solana_sdk::pubkey::Pubkey) {
    let (mut env, m) = Env::with_market();
    let admin = env.admin.insecure_clone();
    env.update_config(
        &admin,
        ConfigUpdate {
            fee_bps: Some(bps),
            ..Default::default()
        },
    )
    .unwrap();
    env.warp(OPEN);
    (env, m)
}

#[test]
fn cfg_06_fee_vault_is_separate_from_collateral_vault() {
    let (mut env, m) = with_fee(100);
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    let mk = env.market(&m);
    let (vault0, acc0) = (env.token_balance(&mk.vault), mk.collateral_accounted);
    let meta = env.bid(&alice, &m, 60, 10, Ioc).unwrap();
    let fee = 10 * 60 * C / 100; // 1% of 6,000,000
    assert_eq!(events::<Fill>(&meta)[0].taker_fee, fee);
    assert_eq!(
        env.book(&m).get().fees_accrued,
        fee,
        "accrued in this market's quote vault"
    );
    let meta = env.sweep_fees(&m).unwrap();
    assert_eq!(events::<FeesSwept>(&meta)[0].amount, fee);
    assert_eq!(
        env.token_balance(&env.fee_vault),
        fee,
        "fee in the fee vault"
    );
    assert_eq!(env.book(&m).get().fees_accrued, 0);
    assert_eq!(
        env.balances(&alice.pubkey(), &m).0,
        1_000 * USDC - 10 * 60 * C - fee
    );
    assert_eq!(
        env.ledger(&m, &bob.pubkey()).free_usdc,
        10 * 60 * C,
        "maker gets the full price"
    );
    let mk = env.market(&m);
    assert_eq!(
        (env.token_balance(&mk.vault), mk.collateral_accounted),
        (vault0, acc0),
        "collateral untouched"
    );
}

#[test]
fn fee_rounding_at_several_notionals() {
    // Rounded up, in the protocol's favour.
    assert_eq!(taker_fee(C, 1), 1);
    assert_eq!(taker_fee(60 * C, 25), 1_500);
    assert_eq!(taker_fee(99 * C * 3, 7), 2_079); // exact
    assert_eq!(taker_fee(123_457, 25), 309); // 308.64 rounds up
    assert_eq!(taker_fee(1, 1_000), 1);
    assert_eq!(taker_fee(10 * 60 * C, 0), 0);
}

#[test]
fn sell_side_and_buy_no_fees_are_charged_and_recorded() {
    let (mut env, m) = with_fee(50);
    let carol = env.user(1_000 * USDC);
    let alice = env.user_with_yes(&m, 1_000 * USDC, 10);
    env.bid(&carol, &m, 58, 20, Gtc).unwrap();
    // Sell Yes: fee taken out of the proceeds.
    env.ask(&alice, &m, 58, 10, Ioc).unwrap();
    let f1 = taker_fee(10 * 58 * C, 50);
    assert_eq!(
        env.balances(&alice.pubkey(), &m).0,
        1_000 * USDC + 10 * 58 * C - f1
    );
    // Buy No market: fee paid on the Yes fill notional.
    let dave = env.user(100 * USDC);
    let meta = env
        .trade(
            &dave,
            &m,
            TradeIx::BuyNoMarket {
                qty: 10,
                min_yes: 58,
            },
        )
        .unwrap();
    let f2 = taker_fee(10 * 58 * C, 50);
    assert_eq!(events::<Fill>(&meta)[0].taker_fee, f2);
    assert_eq!(
        env.balances(&dave.pubkey(), &m),
        (100 * USDC - 10 * 42 * C - f2, 0, 10)
    );
    assert_eq!(env.book(&m).get().fees_accrued, f1 + f2);
    env.assert_book_escrow(&m, &[alice.pubkey(), carol.pubkey(), dave.pubkey()]);
    env.sweep_fees(&m).unwrap();
    assert_eq!(env.token_balance(&env.fee_vault), f1 + f2);
    env.assert_book_escrow(&m, &[alice.pubkey(), carol.pubkey(), dave.pubkey()]);
}

#[test]
fn zero_fee_produces_no_transfer() {
    let (mut env, m) = with_fee(0);
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 60, 10, Ioc).unwrap();
    assert_eq!(events::<Fill>(&meta)[0].taker_fee, 0);
    assert_eq!(env.book(&m).get().fees_accrued, 0);
    let transfers = meta
        .logs
        .iter()
        .filter(|l| l.contains("Instruction: Transfer"))
        .count();
    assert_eq!(transfers, 2, "taker USDC in, Yes out; no fee transfer");
    let meta = env.sweep_fees(&m).unwrap();
    assert!(events::<FeesSwept>(&meta).is_empty(), "nothing to sweep");
    assert_eq!(env.token_balance(&env.fee_vault), 0);
}
