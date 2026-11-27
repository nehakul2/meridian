//! MER-24 · sell_no (buy Yes, then merge).
//! Matrix: TRD-11, TRD-12, TRD-13, TRD-14.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{Fill, PairMerged, Via},
};
use solana_sdk::signature::{Keypair, Signer};
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

/// A user holding `n` No and nothing else (the Yes half is given to `sink`).
fn holder_of_no(env: &mut Env, m: &solana_sdk::pubkey::Pubkey, n: u64, sink: &Keypair) -> Keypair {
    let u = env.user(n * USDC);
    env.mint_pair(&u, m, n).unwrap();
    let yes = env.market(m).yes_mint;
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&u.pubkey(), &yes),
        &ata(&sink.pubkey(), &yes),
        &u.pubkey(),
        &[],
        n,
    )
    .unwrap();
    env.send(&[ix], &[&u]).unwrap();
    u
}

fn setup() -> (Env, solana_sdk::pubkey::Pubkey, Keypair) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 0, 50);
    (env, m, bob)
}

#[test]
fn trd_11_sell_no_buys_yes_and_merges() {
    let (mut env, m, bob) = setup();
    let alice = holder_of_no(&mut env, &m, 10, &bob);
    env.ask(&bob, &m, 40, 50, Gtc).unwrap();
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::SellNo {
                qty: 10,
                max_yes: 41,
            },
        )
        .unwrap();
    assert_eq!(events::<Fill>(&meta)[0].price, 40);
    let merged = events::<PairMerged>(&meta);
    assert_eq!((merged[0].n, merged[0].via), (10, Via::SellNo));
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (10 * 60 * C, 0, 0),
        "+$6.00 net, no Yes left"
    );
    assert_eq!(env.ledger(&m, &bob.pubkey()).free_usdc, 10 * 40 * C);
    let mk = env.market(&m);
    assert_eq!(mk.pairs_outstanding, 50, "60 minted, 10 merged");
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn trd_12_qty_above_no_balance_rejected() {
    let (mut env, m, bob) = setup();
    let alice = holder_of_no(&mut env, &m, 5, &bob);
    env.ask(&bob, &m, 40, 50, Gtc).unwrap();
    assert_err(
        env.trade(
            &alice,
            &m,
            TradeIx::SellNo {
                qty: 10,
                max_yes: 41,
            },
        ),
        MeridianError::InsufficientTokens,
    );
    assert_eq!(env.book(&m).level(Side::Ask, 40)[0].2, 50, "nothing bought");
}

#[test]
fn trd_13_partial_fill_merges_only_filled_qty() {
    let (mut env, m, bob) = setup();
    let alice = holder_of_no(&mut env, &m, 10, &bob);
    env.ask(&bob, &m, 40, 3, Gtc).unwrap();
    env.trade(
        &alice,
        &m,
        TradeIx::SellNo {
            qty: 10,
            max_yes: 41,
        },
    )
    .unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (3 * 60 * C, 0, 7),
        "keeps 7 No, no stray Yes"
    );
}

#[test]
fn trd_13b_no_asks_under_max_price_changes_nothing() {
    let (mut env, m, bob) = setup();
    let alice = holder_of_no(&mut env, &m, 10, &bob);
    env.ask(&bob, &m, 45, 10, Gtc).unwrap();
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::SellNo {
                qty: 10,
                max_yes: 41,
            },
        )
        .unwrap();
    assert!(events::<Fill>(&meta).is_empty());
    assert!(events::<PairMerged>(&meta).is_empty());
    assert_eq!(env.balances(&alice.pubkey(), &m), (0, 0, 10));
}

#[test]
fn trd_14_sell_no_limit_rests_yes_bid_then_merges_via_claim() {
    // Tx Builder maps SELL_NO LIMIT at No price 60 to BID 40 GTC. The filled Yes waits in
    // the ledger; the user's next tx bundles withdraw + merge_pair.
    let (mut env, m, bob) = setup();
    let alice = holder_of_no(&mut env, &m, 10, &bob);
    let a_usdc = 1_000 * USDC;
    let mint = env.usdc_mint;
    env.put_token_account(ata(&alice.pubkey(), &mint), mint, alice.pubkey(), a_usdc);
    env.bid(&alice, &m, 40, 10, Gtc).unwrap();
    env.ask(&bob, &m, 40, 10, Ioc).unwrap();
    assert_eq!(env.ledger(&m, &alice.pubkey()).free_yes, 10);
    let w = env.ix_withdraw(&alice.pubkey(), &m, ledger_pda(&m, &alice.pubkey()));
    let mg = env.ix_mint_merge(&alice.pubkey(), &m, 10, true);
    env.send(&[w, mg], &[&alice]).unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (a_usdc + 10 * 60 * C, 0, 0)
    );
}
