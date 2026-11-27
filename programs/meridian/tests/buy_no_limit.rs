//! MER-23 · buy_no_limit and auto-merge on cancel.
//! Matrix: TRD-07, TRD-08. The prune-after-close half (a BUY_NO order merged by
//! prune_orders) lands with MER-35 (CLN-02).
mod common;

use common::*;
use meridian::{
    constants::*,
    events::{OrderPlaced, OrderTag, PairMerged, PairMinted, Via},
    state::ORDER_TAG_BUY_NO,
};
use solana_sdk::signature::Signer;
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

fn trd_07_state() -> (
    Env,
    solana_sdk::pubkey::Pubkey,
    solana_sdk::signature::Keypair,
    u64,
) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(1_000 * USDC);
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::BuyNoLimit {
                qty: 10,
                yes_price: 62,
            },
        )
        .unwrap();
    let placed = events::<OrderPlaced>(&meta);
    assert_eq!(placed.len(), 1);
    assert_eq!(
        (
            placed[0].tag,
            placed[0].qty,
            placed[0].price,
            placed[0].side
        ),
        (OrderTag::BuyNo, 10, 62, Side::Ask)
    );
    let minted = events::<PairMinted>(&meta);
    assert_eq!((minted[0].n, minted[0].via), (10, Via::BuyNo));
    let id = placed[0].order_id;
    (env, m, alice, id)
}

#[test]
fn trd_07_buy_no_limit_mints_and_rests_yes_ask_tagged_buy_no() {
    let (env, m, alice, id) = trd_07_state();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (990 * USDC, 0, 10),
        "holds 10 No"
    );
    let lvl = env.book(&m).level(Side::Ask, 62);
    assert_eq!(lvl, vec![(alice.pubkey(), id, 10, ORDER_TAG_BUY_NO)]);
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.locked_yes, l.pending_buy_no), (10, 10));
    assert_eq!(
        env.token_balance(&seeded(BASE_VAULT_SEED, &m)),
        10,
        "10 Yes locked in the book"
    );
    let mk = env.market(&m);
    assert_eq!(
        (mk.pairs_outstanding, mk.collateral_accounted),
        (10, 10 * USDC)
    );
}

#[test]
fn trd_08_partial_fill_then_cancel_merges_the_rest() {
    let (mut env, m, alice, id) = trd_07_state();
    let carol = env.user(1_000 * USDC);
    env.bid(&carol, &m, 62, 4, Ioc).unwrap();
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!(
        (l.free_usdc, l.locked_yes, l.pending_buy_no),
        (4 * 62 * C, 6, 6)
    );
    let meta = env.cancel(&alice, &m, id).unwrap();
    let merged = events::<PairMerged>(&meta);
    assert_eq!((merged[0].n, merged[0].via), (6, Via::CancelBuyNo));
    // 6 Yes + 6 No merged: alice +$6.00 to her wallet; she ends with 4 No.
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (990 * USDC + 6 * USDC, 0, 4)
    );
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!(
        (
            l.locked_yes,
            l.free_yes,
            l.pending_buy_no,
            l.open_order_count
        ),
        (0, 0, 0, 0)
    );
    env.withdraw(&alice, &m).unwrap();
    // Net: paid $10, got $6 back and 4 x 62c from carol; holds 4 No at 38c each.
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (1_000 * USDC - 4 * 38 * C, 0, 4)
    );
    let mk = env.market(&m);
    assert_eq!(
        (mk.pairs_outstanding, mk.collateral_accounted),
        (4, 4 * USDC)
    );
    env.assert_book_escrow(&m, &[alice.pubkey(), carol.pubkey()]);
}

#[test]
fn buy_no_limit_no_fill_then_cancel_returns_all_usdc() {
    let (mut env, m, alice, id) = trd_07_state();
    env.cancel(&alice, &m, id).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (1_000 * USDC, 0, 0));
    assert_eq!(env.market(&m).pairs_outstanding, 0);
}

#[test]
fn buy_no_limit_cancel_after_no_was_moved_keeps_yes_in_ledger() {
    // If alice no longer holds the No, only what she holds is merged; the rest of the
    // unfilled Yes stays withdrawable in her ledger (no tokens stranded).
    let (mut env, m, alice, id) = trd_07_state();
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m, 1).unwrap();
    let no_mint = env.market(&m).no_mint;
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&alice.pubkey(), &no_mint),
        &ata(&bob.pubkey(), &no_mint),
        &alice.pubkey(),
        &[],
        7,
    )
    .unwrap();
    env.send(&[ix], &[&alice]).unwrap();
    env.cancel(&alice, &m, id).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (993 * USDC, 0, 0));
    assert_eq!(env.ledger(&m, &alice.pubkey()).free_yes, 7);
    env.withdraw(&alice, &m).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m).1, 7);
    env.assert_book_escrow(&m, &[alice.pubkey()]);
}

#[test]
fn buy_no_limit_crossing_bids_fill_immediately() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let carol = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    env.bid(&carol, &m, 65, 3, Gtc).unwrap();
    let meta = env
        .trade(
            &alice,
            &m,
            TradeIx::BuyNoLimit {
                qty: 10,
                yes_price: 62,
            },
        )
        .unwrap();
    assert_eq!(events::<OrderPlaced>(&meta)[0].qty, 7);
    // 3 sold at carol's 65; proceeds straight to alice.
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (990 * USDC + 3 * 65 * C, 0, 10)
    );
    assert_eq!(env.ledger(&m, &alice.pubkey()).pending_buy_no, 7);
    assert_eq!(env.ledger(&m, &carol.pubkey()).free_yes, 3);
    env.assert_book_escrow(&m, &[alice.pubkey(), carol.pubkey()]);
}
