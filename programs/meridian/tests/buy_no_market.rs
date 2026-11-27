//! MER-22 · buy_no_market (mint exactly the fillable quantity).
//! Matrix: TRD-04, TRD-05, TRD-06.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{Fill, PairMinted, Via},
};
use solana_sdk::signature::Signer;
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

#[test]
fn trd_04_buy_no_market_mints_and_sells_yes_atomically() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let carol = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    env.bid(&carol, &m, 61, 100, Gtc).unwrap();
    let vault_before = env.token_balance(&env.market(&m).vault);
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::BuyNoMarket {
                qty: 10,
                min_yes: 61,
            },
        )
        .unwrap();
    // One tx: 10 pairs minted, 10 Yes sold to carol at 61, alice keeps 10 No at 39.
    assert_eq!(
        env.token_balance(&env.market(&m).vault),
        vault_before + 10 * USDC
    );
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (1_000 * USDC - 10 * 39 * C, 0, 10)
    );
    let minted = events::<PairMinted>(&meta);
    assert_eq!(
        (minted[0].n, minted[0].via, minted[0].owner),
        (10, Via::BuyNo, alice.pubkey())
    );
    let fills = events::<Fill>(&meta);
    assert_eq!(
        (fills[0].maker, fills[0].price, fills[0].qty),
        (carol.pubkey(), 61, 10)
    );
    // Effective No cost = $1 - Yes fill price, verifiable from events.
    let no_cost: u64 = fills
        .iter()
        .map(|f| f.qty * (100 - f.price as u64) * C)
        .sum();
    assert_eq!(no_cost, 10 * 39 * C);
    let l = env.ledger(&m, &carol.pubkey());
    assert_eq!((l.free_yes, l.locked_usdc), (10, 90 * 61 * C));
    let mk = env.market(&m);
    assert_eq!(
        (mk.pairs_outstanding, mk.collateral_accounted),
        (10, 10 * USDC)
    );
    env.assert_book_escrow(&m, &[alice.pubkey(), carol.pubkey()]);
}

#[test]
fn trd_05_thin_bids_mint_only_the_filled_quantity() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let carol = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    env.bid(&carol, &m, 61, 4, Gtc).unwrap();
    env.trade(
        &alice,
        &m,
        TradeIx::BuyNoMarket {
            qty: 10,
            min_yes: 60,
        },
    )
    .unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (1_000 * USDC - 4 * 39 * C, 0, 4)
    );
    let mk = env.market(&m);
    assert_eq!(mk.pairs_outstanding, 4, "mints exactly 4");
    assert_eq!(env.mint_info(&mk.yes_mint).supply, 4);
    assert_eq!(
        env.token_balance(&seeded(BASE_VAULT_SEED, &m)),
        4,
        "the 4 Yes are carol's, in the book"
    );
}

#[test]
fn trd_06_no_fillable_bids_fails_cleanly() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let carol = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    env.bid(&carol, &m, 50, 100, Gtc).unwrap();
    assert_err(
        env.trade(
            &alice,
            &m,
            TradeIx::BuyNoMarket {
                qty: 10,
                min_yes: 60,
            },
        ),
        MeridianError::NoLiquidity,
    );
    assert_eq!(env.market(&m).pairs_outstanding, 0);
    assert_eq!(env.balances(&alice.pubkey(), &m).0, 1_000 * USDC);
    // Empty book too.
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(1_000 * USDC);
    assert_err(
        env.trade(&alice, &m, TradeIx::BuyNoMarket { qty: 1, min_yes: 1 }),
        MeridianError::NoLiquidity,
    );
}

#[test]
fn buy_no_market_walks_levels_best_first() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let b1 = env.user(1_000 * USDC);
    let b2 = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    env.bid(&b1, &m, 58, 5, Gtc).unwrap();
    env.bid(&b2, &m, 62, 5, Gtc).unwrap();
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::BuyNoMarket {
                qty: 8,
                min_yes: 55,
            },
        )
        .unwrap();
    let got: Vec<_> = events::<Fill>(&meta)
        .iter()
        .map(|f| (f.price, f.qty))
        .collect();
    assert_eq!(got, vec![(62, 5), (58, 3)]);
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (1_000 * USDC - (5 * 38 + 3 * 42) * C, 0, 8)
    );
    env.assert_book_escrow(&m, &[alice.pubkey(), b1.pubkey(), b2.pubkey()]);
}
