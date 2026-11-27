//! MER-20 · OrderBook account and place_order matching with halt at close.
//!
//! Matrix: BOOK-01..09, BOOK-13, BOOK-14, BOOK-15, HLT-01, HLT-02, TRD-01, TRD-02, TRD-03,
//! TRD-09, TRD-10, TRD-15, TRD-17, SEC-01, SEC-09, CAL-09, plus the order halves of CAL-02,
//! MNT-05 and INV-09.
//!
//! Amounts follow D24: 10,000 micro-USDC per cent, so 10 contracts at 55 cents cost
//! 5,500,000 micro-USDC.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{CancelReason, Fill, OrderCancelled, OrderPlaced, OrderTag},
    state::*,
};
use solana_sdk::{
    address_lookup_table::AddressLookupTableAccount,
    compute_budget::ComputeBudgetInstruction,
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};

/// micro-USDC per cent (D24).
const C: u64 = MICRO_USDC_PER_CENT;
use TimeInForce::*;

fn open() -> (Env, Pubkey) {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    (env, m)
}

fn yes_of(env: &Env, u: &Keypair, m: &Pubkey) -> u64 {
    env.balances(&u.pubkey(), m).1
}
fn usdc_of(env: &Env, u: &Keypair) -> u64 {
    env.token_balance(&ata(&u.pubkey(), &env.usdc_mint))
}

#[test]
fn book_01_price_priority_best_price_fills_first() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let carol = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 62, 10, Gtc).unwrap();
    env.ask(&carol, &m, 60, 10, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 62, 15, Ioc).unwrap();
    let fills = events::<Fill>(&meta);
    let got: Vec<_> = fills.iter().map(|f| (f.maker, f.price, f.qty)).collect();
    assert_eq!(
        got,
        vec![(carol.pubkey(), 60, 10), (bob.pubkey(), 62, 5)],
        "carol @60 first, then bob @62"
    );
    assert!(fills[0].seq < fills[1].seq);
    assert_eq!(yes_of(&env, &alice, &m), 15);
    assert_eq!(usdc_of(&env, &alice), 1_000 * USDC - (10 * 60 + 5 * 62) * C);
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey(), carol.pubkey()]);
}

#[test]
fn book_02_time_priority_at_same_price() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let carol = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    env.ask(&carol, &m, 60, 10, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 60, 12, Ioc).unwrap();
    let got: Vec<_> = events::<Fill>(&meta)
        .iter()
        .map(|f| (f.maker, f.qty))
        .collect();
    assert_eq!(got, vec![(bob.pubkey(), 10), (carol.pubkey(), 2)]);
    let lvl = env.book(&m).level(Side::Ask, 60);
    assert_eq!(lvl.len(), 1);
    assert_eq!(
        (lvl[0].0, lvl[0].2),
        (carol.pubkey(), 8),
        "carol keeps her place with 8"
    );
}

#[test]
fn book_03_fill_at_makers_price_not_takers() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 55, 10, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 70, 10, Ioc).unwrap();
    assert_eq!(events::<Fill>(&meta)[0].price, 55);
    assert_eq!(
        usdc_of(&env, &alice),
        1_000 * USDC - 10 * 55 * C,
        "pays 5,500,000, not 7,000,000"
    );
    assert_eq!(
        env.ledger(&m, &alice.pubkey()).locked_usdc,
        0,
        "nothing left locked"
    );
}

#[test]
fn book_04_gtc_remainder_rests() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 5);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 5, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 60, 8, Gtc).unwrap();
    assert_eq!(events::<Fill>(&meta).iter().map(|f| f.qty).sum::<u64>(), 5);
    let placed = events::<OrderPlaced>(&meta);
    assert_eq!(placed.len(), 1);
    assert_eq!(
        (placed[0].qty, placed[0].price, placed[0].side),
        (3, 60, Side::Bid)
    );
    assert_eq!(placed[0].client_id, 7);
    let lvl = env.book(&m).level(Side::Bid, 60);
    assert_eq!(lvl, vec![(alice.pubkey(), placed[0].order_id, 3, 0)]);
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.locked_usdc, l.open_order_count), (3 * 60 * C, 1));
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn book_05_ioc_remainder_is_cancelled() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 5);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 5, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 60, 8, Ioc).unwrap();
    assert_eq!(events::<Fill>(&meta).iter().map(|f| f.qty).sum::<u64>(), 5);
    let c = events::<OrderCancelled>(&meta);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].reason, c[0].qty), (CancelReason::IocRemainder, 3));
    assert!(events::<OrderPlaced>(&meta).is_empty());
    assert_eq!(env.book(&m).get().order_count, 0, "no resting order");
    assert_eq!(env.ledger(&m, &alice.pubkey()).locked_usdc, 0);
}

#[test]
fn book_06_post_only_rejected_if_it_would_cross() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 5);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 5, Gtc).unwrap();
    assert_err(
        env.bid(&alice, &m, 60, 5, PostOnly),
        MeridianError::WouldCross,
    );
    assert_eq!(yes_of(&env, &alice, &m), 0, "no fill");
    env.bid(&alice, &m, 59, 5, PostOnly).unwrap();
    assert_eq!(env.book(&m).level(Side::Bid, 59).len(), 1);
}

#[test]
fn book_07_price_bounds_1_to_99() {
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    for p in [0u8, 100, 150] {
        assert_err(env.bid(&alice, &m, p, 1, Gtc), MeridianError::InvalidPrice);
        assert_err(env.ask(&alice, &m, p, 1, Gtc), MeridianError::InvalidPrice);
    }
    env.bid(&alice, &m, 1, 1, Gtc).unwrap();
    env.bid(&alice, &m, 99, 1, Gtc).unwrap();
}

#[test]
fn book_08_qty_zero_rejected() {
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    assert_err(env.bid(&alice, &m, 50, 0, Gtc), MeridianError::ZeroQuantity);
}

#[test]
fn book_09_escrow_bid_locks_usdc_ask_locks_yes() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    env.bid(&alice, &m, 40, 10, Gtc).unwrap();
    assert_eq!(env.ledger(&m, &bob.pubkey()).locked_yes, 10);
    assert_eq!(env.ledger(&m, &alice.pubkey()).locked_usdc, 10 * 40 * C);
    assert_eq!(env.token_balance(&seeded(BASE_VAULT_SEED, &m)), 10);
    assert_eq!(
        env.token_balance(&seeded(QUOTE_VAULT_SEED, &m)),
        10 * 40 * C
    );
    assert_eq!(yes_of(&env, &bob, &m), 0);
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn book_13_self_trade_cancels_the_resting_order() {
    // Documented rule: the taker's own resting order is cancelled (unlocked to the
    // ledger) and matching continues; there is never a fill, or a fee, against oneself.
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 1_000 * USDC, 10);
    let bob = env.user_with_yes(&m, 0, 10);
    env.ask(&alice, &m, 60, 10, Gtc).unwrap();
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    let id = env.book(&m).level(Side::Ask, 60)[0].1;
    let meta = env.bid(&alice, &m, 60, 4, Ioc).unwrap();
    let c = events::<OrderCancelled>(&meta);
    assert!(c
        .iter()
        .any(|e| e.order_id == id && e.reason == CancelReason::SelfTrade && e.qty == 10));
    let fills = events::<Fill>(&meta);
    assert!(fills.iter().all(|f| f.maker != alice.pubkey()));
    assert_eq!(
        fills.iter().map(|f| (f.maker, f.qty)).collect::<Vec<_>>(),
        vec![(bob.pubkey(), 4)]
    );
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!((l.locked_yes, l.free_yes, l.open_order_count), (0, 10, 0));
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
}

#[test]
fn book_14_full_level_rejects_without_overwriting() {
    let (mut env, m) = open();
    let mut owners = vec![];
    for _ in 0..LEVEL_CAPACITY {
        let u = env.user(10 * USDC);
        env.bid(&u, &m, 40, 1, Gtc).unwrap();
        owners.push(u.pubkey());
    }
    let late = env.user(10 * USDC);
    assert_err(env.bid(&late, &m, 40, 1, Gtc), MeridianError::LevelFull);
    let lvl = env.book(&m).level(Side::Bid, 40);
    assert_eq!(
        lvl.iter().map(|o| o.0).collect::<Vec<_>>(),
        owners,
        "existing orders untouched"
    );
    assert_eq!(usdc_of(&env, &late), 10 * USDC);
    // A different level still accepts.
    env.bid(&late, &m, 39, 1, Gtc).unwrap();
}

#[test]
fn book_15_order_before_open_time_rejected() {
    let (mut env, m) = Env::with_market();
    let alice = env.user(1_000 * USDC);
    env.warp(OPEN - 1);
    assert_err(
        env.bid(&alice, &m, 40, 1, Gtc),
        MeridianError::MarketNotOpen,
    );
    env.warp(OPEN);
    env.bid(&alice, &m, 40, 1, Gtc).unwrap();
}

#[test]
fn mnt_05_order_at_0845_fails_market_not_open() {
    let (mut env, m) = Env::with_market();
    let alice = env.user(1_000 * USDC);
    env.warp(MINT_OPEN + 15 * 60);
    env.mint_pair(&alice, &m, 10).unwrap();
    assert_err(
        env.ask(&alice, &m, 60, 10, Gtc),
        MeridianError::MarketNotOpen,
    );
}

#[test]
fn hlt_01_orders_rejected_at_exactly_close_time() {
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 1_000 * USDC, 20);
    env.warp(CLOSE - 1);
    env.bid(&alice, &m, 40, 1, Gtc).unwrap();
    env.warp(CLOSE);
    assert_err(env.bid(&alice, &m, 40, 1, Gtc), MeridianError::MarketHalted);
    for t in [
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
        assert_err(env.trade(&alice, &m, t), MeridianError::MarketHalted);
    }
}

#[test]
fn cal_02_half_day_order_at_1300_rejected() {
    // 2026-11-27 is a half day: close 13:00 ET = 18:00 UTC.
    let mut env = Env::new();
    let date = 20261127;
    let mint_open = MINT_OPEN + 2 * 86_400;
    let open = OPEN + 2 * 86_400;
    let close = open + 3 * 3_600 + 30 * 60;
    env.create_ticker_day("META", date, mint_open, open, close)
        .unwrap();
    env.create_market("META", date, STRIKE_680).unwrap();
    let m = market_pda("META", date, STRIKE_680);
    let alice = env.user(100 * USDC);
    env.warp(close - 1);
    env.bid(&alice, &m, 40, 1, Gtc).unwrap();
    env.warp(close);
    assert_err(env.bid(&alice, &m, 40, 1, Gtc), MeridianError::MarketHalted);
}

#[test]
fn hlt_02_resting_orders_cannot_be_filled_after_close() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 40, 10, Gtc).unwrap();
    env.warp(CLOSE + 30);
    assert_err(
        env.bid(&alice, &m, 40, 10, Ioc),
        MeridianError::MarketHalted,
    );
    assert_err(
        env.trade(
            &alice,
            &m,
            TradeIx::SellNo {
                qty: 1,
                max_yes: 40,
            },
        ),
        MeridianError::MarketHalted,
    );
    let lvl = env.book(&m).level(Side::Ask, 40);
    assert_eq!((lvl[0].0, lvl[0].2), (bob.pubkey(), 10), "bob untouched");
    assert_eq!(env.ledger(&m, &bob.pubkey()).locked_yes, 10);
}

#[test]
fn cal_09_program_decides_by_chain_clock_only() {
    // Wall clock 16:00:01 but the chain says 15:59:59: accepted. The program reads Clock only.
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    env.warp(CLOSE - 2);
    env.bid(&alice, &m, 40, 1, Gtc).unwrap();
    env.warp(CLOSE);
    assert_err(env.bid(&alice, &m, 40, 1, Gtc), MeridianError::MarketHalted);
    // record_close half: MER-31.
}

#[test]
fn trd_01_buy_yes_market_ioc_with_worst_price() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 50);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 50, Gtc).unwrap();
    env.bid(&alice, &m, 62, 20, Ioc).unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (1_000 * USDC - 20 * 60 * C, 20, 0)
    );
    assert_eq!(env.ledger(&m, &bob.pubkey()).free_usdc, 20 * 60 * C);
}

#[test]
fn trd_02_worst_price_protects_against_slippage() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 55);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 5, Gtc).unwrap();
    env.ask(&bob, &m, 70, 50, Gtc).unwrap();
    let meta = env.bid(&alice, &m, 62, 20, Ioc).unwrap();
    let fills = events::<Fill>(&meta);
    assert!(fills.iter().all(|f| f.price <= 62), "never fills at 70");
    assert_eq!(fills.iter().map(|f| f.qty).sum::<u64>(), 5);
    assert_eq!(events::<OrderCancelled>(&meta)[0].qty, 15);
    assert_eq!(env.book(&m).level(Side::Ask, 70)[0].2, 50);
}

#[test]
fn trd_03_buy_yes_limit_rests_and_fills_later() {
    let (mut env, m) = open();
    let alice = env.user(1_000 * USDC);
    let bob = env.user_with_yes(&m, 0, 10);
    env.bid(&alice, &m, 55, 10, Gtc).unwrap();
    assert_eq!(env.book(&m).level(Side::Bid, 55).len(), 1);
    env.ask(&bob, &m, 55, 10, Ioc).unwrap();
    let l = env.ledger(&m, &alice.pubkey());
    assert_eq!(
        (l.free_yes, l.locked_usdc),
        (10, 0),
        "maker's Yes waits in the ledger"
    );
    assert_eq!(
        usdc_of(&env, &bob),
        10 * 55 * C,
        "taker paid in the same tx"
    );
    env.withdraw(&alice, &m).unwrap();
    assert_eq!(yes_of(&env, &alice, &m), 10);
}

#[test]
fn trd_09_sell_yes_market() {
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 0, 20);
    let carol = env.user(1_000 * USDC);
    env.bid(&carol, &m, 58, 50, Gtc).unwrap();
    env.ask(&alice, &m, 57, 20, Ioc).unwrap();
    assert_eq!(yes_of(&env, &alice, &m), 0);
    assert_eq!(usdc_of(&env, &alice), 20 * 58 * C, "fills at the bid, 58");
    assert_eq!(env.ledger(&m, &carol.pubkey()).free_yes, 20);
}

#[test]
fn trd_10_sell_yes_limit_rests() {
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 0, 20);
    env.ask(&alice, &m, 65, 20, Gtc).unwrap();
    assert_eq!(env.ledger(&m, &alice.pubkey()).locked_yes, 20);
    assert_eq!(env.book(&m).level(Side::Ask, 65)[0].2, 20);
}

#[test]
fn trd_15_buy_yes_and_sell_no_hit_the_same_side() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 20);
    let alice = env.user(1_000 * USDC);
    let carol = env.user(1_000 * USDC);
    env.mint_pair(&carol, &m, 10).unwrap();
    // carol holds 10 No only.
    let to = ata(&bob.pubkey(), &env.market(&m).yes_mint);
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&carol.pubkey(), &env.market(&m).yes_mint),
        &to,
        &carol.pubkey(),
        &[],
        10,
    )
    .unwrap();
    env.send(&[ix], &[&carol]).unwrap();
    env.ask(&bob, &m, 40, 20, Gtc).unwrap();
    env.bid(&alice, &m, 40, 10, Ioc).unwrap();
    let meta = env
        .trade(
            &carol,
            &m,
            TradeIx::SellNo {
                qty: 10,
                max_yes: 40,
            },
        )
        .unwrap();
    assert_eq!(events::<Fill>(&meta)[0].maker, bob.pubkey());
    assert!(env.book(&m).level(Side::Ask, 40).is_empty(), "0 left at 40");
    assert_eq!(env.ledger(&m, &bob.pubkey()).free_usdc, 20 * 40 * C);
}

#[test]
fn trd_17_buy_no_walking_20_levels_fits_size_and_compute() {
    let (mut env, m) = open();
    let mut makers = vec![];
    for i in 0..20u8 {
        let u = env.user(100 * USDC);
        env.bid(&u, &m, 80 - i, 1, Gtc).unwrap();
        makers.push(u.pubkey());
    }
    let alice = env.user(1_000 * USDC);
    let t = TradeIx::BuyNoMarket {
        qty: 20,
        min_yes: 1,
    };
    let ix = env.ix_trade_auto(&alice.pubkey(), &m, &t);
    assert_eq!(
        ix.accounts.len(),
        19 + 20,
        "19 fixed accounts + 20 maker ledgers"
    );

    // Size: v0 message with a lookup table holding the market's fixed accounts. The
    // user's own accounts (wallet, ledger, ATAs) and the 20 maker ledgers stay inline.
    let mk = env.market(&m);
    let user_specific = [
        alice.pubkey(),
        ledger_pda(&m, &alice.pubkey()),
        ata(&alice.pubkey(), &env.usdc_mint),
        ata(&alice.pubkey(), &mk.yes_mint),
        ata(&alice.pubkey(), &mk.no_mint),
    ];
    let fixed: Vec<Pubkey> = ix.accounts[..19]
        .iter()
        .map(|a| a.pubkey)
        .filter(|k| !user_specific.contains(k))
        .collect();
    let alt = AddressLookupTableAccount {
        key: Pubkey::new_unique(),
        addresses: fixed,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let msg = v0::Message::try_compile(
        &alice.pubkey(),
        &[cu.clone(), ix.clone()],
        &[alt],
        env.svm.latest_blockhash(),
    )
    .unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[&alice]).unwrap();
    let size = bincode::serialize(&tx).unwrap().len();
    assert!(size <= 1_232, "Buy No over 20 levels is {size} bytes");

    // Compute: within a 400k budget with >= 20% headroom.
    let meta = env.send(&[cu, ix], &[&alice]).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m).2, 20);
    let used = meta.compute_units_consumed;
    println!("TRD-17: {size} bytes, {used} CU for 20 fills");
    assert!(used <= 320_000, "used {used} CU");
}

#[test]
fn sec_01_place_order_with_another_markets_book_fails() {
    let (mut env, m680) = open();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let alice = env.user(1_000 * USDC);
    let t = TradeIx::Place {
        side: Side::Bid,
        price: 40,
        qty: 1,
        tif: Gtc,
    };
    let swaps: [(usize, Pubkey); 4] = [
        (4, env.market(&m700).book),
        (5, seeded(BASE_VAULT_SEED, &m700)),
        (6, seeded(QUOTE_VAULT_SEED, &m700)),
        (7, env.market(&m700).vault),
    ];
    for (i, k) in swaps {
        let mut ix = env.ix_trade(&alice.pubkey(), &m680, &t, &[]);
        ix.accounts[i].pubkey = k;
        assert_fails(env.send(&[ix], &[&alice]));
    }
    assert_eq!(usdc_of(&env, &alice), 1_000 * USDC);
}

#[test]
fn sec_09_sandwich_resistance_via_worst_price() {
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let eve = env.user_with_yes(&m, 1_000 * USDC, 0);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    // alice's tx is built against the honest book...
    let ix = env.ix_trade_auto(
        &alice.pubkey(),
        &m,
        &TradeIx::Place {
            side: Side::Bid,
            price: 62,
            qty: 10,
            tif: Ioc,
        },
    );
    // ...eve front-runs: lifts the 60 ask and re-offers at 75.
    env.bid(&eve, &m, 60, 10, Ioc).unwrap();
    env.withdraw(&eve, &m).ok();
    env.ask(&eve, &m, 75, 10, Gtc).unwrap();
    let meta = env.send(&[ix], &[&alice]).unwrap();
    assert!(
        events::<Fill>(&meta).is_empty(),
        "nothing above the worst price of 62"
    );
    assert_eq!(env.balances(&alice.pubkey(), &m), (1_000 * USDC, 0, 0));
}

#[test]
fn inv_09_huge_orders_rejected_cleanly() {
    let (mut env, m) = open();
    let alice = env.user(u64::MAX / 2);
    for q in [u64::MAX, MAX_ORDER_QTY + 1] {
        assert_err(
            env.bid(&alice, &m, 99, q, Gtc),
            MeridianError::OrderTooLarge,
        );
        assert_err(
            env.trade(
                &alice,
                &m,
                TradeIx::BuyNoLimit {
                    qty: q,
                    yes_price: 50,
                },
            ),
            MeridianError::OrderTooLarge,
        );
    }
    env.bid(&alice, &m, 99, MAX_ORDER_QTY, Gtc).unwrap();
    assert_eq!(
        env.ledger(&m, &alice.pubkey()).locked_usdc,
        MAX_ORDER_QTY * 99 * C
    );
}

#[test]
fn missing_maker_ledger_stops_ioc_and_blocks_crossing_gtc() {
    // The taker must pass the makers' ledgers. Matching stops at the first missing one
    // (price-time priority is never skipped); a GTC remainder that would rest crossed fails.
    let (mut env, m) = open();
    let bob = env.user_with_yes(&m, 0, 10);
    let carol = env.user_with_yes(&m, 0, 10);
    let alice = env.user(1_000 * USDC);
    env.ask(&bob, &m, 60, 10, Gtc).unwrap();
    env.ask(&carol, &m, 61, 10, Gtc).unwrap();
    let carol_only = [ledger_pda(&m, &carol.pubkey())];
    let ioc = TradeIx::Place {
        side: Side::Bid,
        price: 61,
        qty: 15,
        tif: Ioc,
    };
    let ix = env.ix_trade(&alice.pubkey(), &m, &ioc, &carol_only);
    let meta = env.send(&[ix], &[&alice]).unwrap();
    assert!(events::<Fill>(&meta).is_empty());
    let gtc = TradeIx::Place {
        side: Side::Bid,
        price: 61,
        qty: 15,
        tif: Gtc,
    };
    let ix = env.ix_trade(&alice.pubkey(), &m, &gtc, &carol_only);
    assert_err(
        env.send(&[ix], &[&alice]),
        MeridianError::MakerLedgerMissing,
    );
    // A ledger of another market is ignored, not trusted.
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let dave = env.user(100 * USDC);
    env.bid(&dave, &m700, 10, 1, Gtc).unwrap();
    let ix = env.ix_trade(
        &alice.pubkey(),
        &m,
        &ioc,
        &[ledger_pda(&m700, &dave.pubkey())],
    );
    let meta = env.send(&[ix], &[&alice]).unwrap();
    assert!(events::<Fill>(&meta).is_empty());
}

#[test]
fn order_placed_carries_tag_and_book_is_never_crossed() {
    let (mut env, m) = open();
    let alice = env.user_with_yes(&m, 1_000 * USDC, 10);
    let meta = env.ask(&alice, &m, 70, 10, Gtc).unwrap();
    assert_eq!(events::<OrderPlaced>(&meta)[0].tag, OrderTag::None);
    let bob = env.user(1_000 * USDC);
    env.bid(&bob, &m, 75, 4, Gtc).unwrap();
    let v = env.book(&m);
    let b = v.get();
    assert_eq!(b.best(SIDE_ASK), Some(70));
    assert_eq!(
        b.best(SIDE_BID),
        None,
        "bid crossed and filled instead of resting"
    );
}
