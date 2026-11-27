//! MER-35 · prune_orders and close_book (D12, D15, D29, D30).
//! Matrix: CLN-01 to CLN-06.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{BookClosed, CancelReason, OrderCancelled, PairMerged, Via},
};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

/// Price of maker `i`'s `j`-th order: even makers bid 1..49 cents, odd makers ask
/// 51..99, spread so no level overflows.
fn price_of(i: usize, j: u8) -> u8 {
    let k = ((i / 2) * 7 + j as usize) % 49;
    if i % 2 == 0 {
        1 + k as u8
    } else {
        51 + k as u8
    }
}

/// `n` makers resting `per` orders of 3 contracts each (see `price_of`). Clock at OPEN.
fn resting(n: usize, per: u8) -> (Env, Pubkey, Vec<Keypair>) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let mut makers = vec![];
    for i in 0..n {
        let k = env.user_with_yes(&m, 100 * USDC, 3 * per as u64);
        for j in 0..per {
            if i % 2 == 0 {
                env.bid(&k, &m, price_of(i, j), 3, Gtc).unwrap();
            } else {
                env.ask(&k, &m, price_of(i, j), 3, Gtc).unwrap();
            }
        }
        makers.push(k);
    }
    (env, m, makers)
}

fn owners(ks: &[Keypair]) -> Vec<Pubkey> {
    ks.iter().map(|k| k.pubkey()).collect()
}

#[test]
fn cln_01_prune_returns_resting_funds_after_settlement() {
    let (mut env, m, makers) = resting(6, 5); // 30 orders
    assert_eq!(env.book(&m).get().order_count, 30);
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    let mut cancelled = 0;
    for _ in 0..3 {
        let meta = env.prune(&m, 10).unwrap();
        let evs = events::<OrderCancelled>(&meta);
        assert!(evs.iter().all(|e| e.reason == CancelReason::Prune));
        cancelled += evs.len();
    }
    assert_eq!(cancelled, 30);
    assert_eq!(env.book(&m).get().order_count, 0);
    for (i, k) in makers.iter().enumerate() {
        let l = env.ledger(&m, &k.pubkey());
        assert_eq!((l.locked_usdc, l.locked_yes, l.open_order_count), (0, 0, 0));
        if i % 2 == 0 {
            let cents: u64 = (0..5).map(|j| 3 * price_of(i, j) as u64).sum();
            assert_eq!(l.free_usdc, cents * C);
        } else {
            assert_eq!(l.free_yes, 15);
        }
    }
    env.assert_book_escrow(&m, &owners(&makers));
    // Nothing left: a further prune is a no-op.
    env.prune(&m, 10).unwrap();
}

/// alice rests a BUY_NO ask of 6 at 70 cents (holds 6 No); nothing fills.
fn buy_no_resting() -> (Env, Pubkey, Keypair) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(6 * USDC);
    env.trade(
        &alice,
        &m,
        TradeIx::BuyNoLimit {
            qty: 6,
            yes_price: 70,
        },
    )
    .unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (0, 0, 6));
    (env, m, alice)
}

#[test]
fn cln_02_prune_converts_unfilled_buy_no_pairs_to_usdc() {
    for price in [px(67_500), px(68_500)] {
        // settled NO, then settled YES: same result
        let (mut env, m, alice) = buy_no_resting();
        env.close_at(price);
        env.settle(&m).unwrap();
        let mk = env.market(&m);
        let accounted = mk.collateral_accounted;
        let meta = env.prune(&m, 10).unwrap();
        let merged = events::<PairMerged>(&meta);
        assert_eq!(
            (merged[0].owner, merged[0].n, merged[0].via),
            (alice.pubkey(), 6, Via::CancelBuyNo)
        );
        let mk = env.market(&m);
        assert_eq!(mk.collateral_accounted, accounted - 6 * USDC);
        assert_eq!(env.mint_info(&mk.yes_mint).supply, 0, "6 Yes burned");
        assert_eq!(env.mint_info(&mk.no_mint).supply, 0, "6 No burned");
        let l = env.ledger(&m, &alice.pubkey());
        assert_eq!(
            (l.free_usdc, l.free_yes, l.pending_buy_no),
            (6 * USDC, 0, 0)
        );
        env.withdraw(&alice, &m).unwrap();
        assert_eq!(
            env.balances(&alice.pubkey(), &m),
            (6 * USDC, 0, 0),
            "nothing stranded"
        );
        env.assert_book_escrow(&m, &[alice.pubkey()]);
        assert_eq!(env.token_balance(&mk.vault), 0);
    }
}

#[test]
fn cln_02_conversion_also_works_halted_before_settlement() {
    let (mut env, m, alice) = buy_no_resting();
    env.warp(CLOSE + 1);
    env.prune(&m, 10).unwrap();
    let mk = env.market(&m);
    assert_eq!((mk.pairs_outstanding, mk.collateral_accounted), (0, 0));
    assert_eq!(env.ledger(&m, &alice.pubkey()).free_usdc, 6 * USDC);
}

#[test]
fn cln_02_without_the_no_account_the_yes_is_unlocked_instead() {
    // A cranker that omits the No account (or a user who revoked the allowance) cannot
    // cost the user anything: the Yes comes back as free Yes, and Yes + No still pay $1.
    let (mut env, m, alice) = buy_no_resting();
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    let ledger = ledger_pda(&m, &alice.pubkey());
    let ix = env.ix_prune(&m, 10, &[ledger]);
    let p = env.payer.insecure_clone();
    env.send(&[ix], &[&p]).unwrap();
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.free_usdc, l.free_yes), (0, 6));
    env.withdraw(&alice, &m).unwrap();
    env.redeem(&alice, &m, 6, 6).unwrap();
    assert_eq!(env.usdc_of(&alice.pubkey()), 6 * USDC);
}

#[test]
fn cln_02_revoked_allowance_falls_back_to_free_yes() {
    let (mut env, m, alice) = buy_no_resting();
    let no = env.market(&m).no_mint;
    let revoke = spl_token::instruction::revoke(
        &spl_token::ID,
        &ata(&alice.pubkey(), &no),
        &alice.pubkey(),
        &[],
    )
    .unwrap();
    env.send(&[revoke], &[&alice]).unwrap();
    env.close_at(px(67_500));
    env.settle(&m).unwrap();
    env.prune(&m, 10).unwrap();
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.free_usdc, l.free_yes), (0, 6));
    assert_eq!(env.balances(&alice.pubkey(), &m).2, 6, "No untouched");
}

#[test]
fn cln_03_prune_is_permissionless_and_bounded() {
    let (mut env, m, _) = resting(20, 10); // 200 orders
    assert_eq!(env.book(&m).get().order_count, 200);
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    let eve = env.user(0);
    let accs = env.prune_accounts(&m);
    let ix = env.ix_prune(&m, 50, &accs);
    let meta = env.send(&[budget(1_400_000), ix], &[&eve]).unwrap();
    assert_eq!(events::<OrderCancelled>(&meta).len(), 50);
    assert_eq!(env.book(&m).get().order_count, 150);
    println!("prune 50 orders: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 1_400_000);
    // Above the per-call cap is refused.
    let ix = env.ix_prune(&m, MAX_PRUNE_BATCH + 1, &env.prune_accounts(&m));
    assert_err(env.send(&[ix], &[&eve]), MeridianError::InvalidConfig);
    while env.book(&m).get().order_count > 0 {
        env.prune(&m, 50).unwrap();
    }
}

#[test]
fn cln_04_prune_refused_while_trading() {
    let (mut env, m, _) = resting(2, 1);
    env.warp(CLOSE - 7_200); // 14:00
    assert_err(env.prune(&m, 10), MeridianError::PruneNotAllowed);
    env.warp(CLOSE - 1);
    assert_err(env.prune(&m, 10), MeridianError::PruneNotAllowed);
    env.warp(CLOSE);
    env.prune(&m, 10).unwrap();
}

#[test]
fn prune_stops_at_the_first_missing_ledger() {
    let (mut env, m, makers) = resting(2, 2); // maker 0 bids, maker 1 asks
    env.close_at(px(68_500));
    // Only maker 1's ledger: maker 0's bids come first in book order, so nothing moves.
    let l1 = ledger_pda(&m, &makers[1].pubkey());
    let ix = env.ix_prune(&m, 10, &[l1]);
    let p = env.payer.insecure_clone();
    assert_err(env.send(&[ix], &[&p]), MeridianError::MakerLedgerMissing);
    assert_eq!(env.book(&m).get().order_count, 4);
}

#[test]
fn cln_05_close_book_only_when_empty_and_settled() {
    let (mut env, m, _) = resting(1, 1);
    env.close_at(px(68_500));
    assert_err(env.close_book(&m), MeridianError::MarketNotSettled);
    env.settle(&m).unwrap();
    assert_err(env.close_book(&m), MeridianError::BookNotEmpty);
    env.prune(&m, 10).unwrap();
    let book = env.market(&m).book;
    let rent = env.svm.get_account(&book).unwrap().lamports;
    let creator = env.creator.pubkey();
    let before = env.svm.get_account(&creator).unwrap().lamports;
    let meta = env.close_book(&m).unwrap();
    assert_eq!(events::<BookClosed>(&meta)[0].market, m);
    assert!(!env.exists(&book), "OrderBook closed");
    assert_eq!(
        env.svm.get_account(&creator).unwrap().lamports,
        before + rent,
        "rent to the automation wallet"
    );
    // Rent can only go to the configured wallet.
    let mut ix = env.ix_close_book(&m);
    ix.accounts[3].pubkey = Pubkey::new_unique();
    let p = env.payer.insecure_clone();
    assert_fails(env.send(&[ix], &[&p]));
}

#[test]
fn close_book_sweeps_accrued_fees() {
    let (mut env, m) = Env::with_market();
    let admin = env.admin.insecure_clone();
    env.update_config(
        &admin,
        meridian::instructions::ConfigUpdate {
            fee_bps: Some(100),
            ..Default::default()
        },
    )
    .unwrap();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(10 * USDC);
    env.ask(&bob, &m, 50, 10, Gtc).unwrap();
    env.bid(&alice, &m, 50, 10, Ioc).unwrap(); // notional $5.00, fee 1% = 50,000
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    env.close_book(&m).unwrap();
    assert_eq!(env.token_balance(&env.fee_vault.clone()), 50_000);
}

#[test]
fn cln_06_redeem_and_withdraw_work_after_close_book() {
    let (mut env, m, makers) = resting(2, 1); // maker 0 bids 3, maker 1 asks 3
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    env.prune(&m, 10).unwrap();
    env.close_book(&m).unwrap();
    for k in &makers {
        env.withdraw(k, &m).unwrap();
    }
    // Both get their 100 USDC / 3 Yes back from the book; each minted 3 pairs.
    assert_eq!(env.balances(&makers[0].pubkey(), &m), (100 * USDC, 3, 3));
    assert_eq!(env.balances(&makers[1].pubkey(), &m), (100 * USDC, 3, 3));
    for k in &makers {
        env.redeem(k, &m, 3, 3).unwrap();
        assert_eq!(env.usdc_of(&k.pubkey()), 103 * USDC);
    }
    let mk = env.market(&m);
    assert_eq!(
        (mk.collateral_accounted, env.token_balance(&mk.vault)),
        (0, 0)
    );
    // A second withdraw with nothing left is harmless.
    env.withdraw(&makers[0], &m).unwrap();
}
