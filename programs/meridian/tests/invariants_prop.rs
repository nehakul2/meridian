//! MER-14 · invariant assertions and property test harness.
//!
//! Matrix: INV-01 to INV-09, MNT-11, SET-11, CON-02 to CON-05, CON-08, CON-09.
//! The generator covers mint / merge / donate / pause / clock / token transfer and,
//! since Phase 2, place_order (GTC, IOC, POST_ONLY), cancel_order, cancel_all,
//! buy_no_market, buy_no_limit, sell_no and withdraw with a 25 bps taker fee. After
//! every step it checks the market invariants, book escrow (INV-05) and that the book's
//! running totals equal the sum of the ledgers, token and USDC conservation, and that
//! supply moves only with PairMinted / PairMerged events. Since Phase 3, one sequence
//! in four ends with the full settlement path (record, finalize, settle, prune,
//! close_book, withdraw, redeem) and checks that every claim is paid (CON-05).
//!
//! `PROP_SEQUENCES` (default 10,000) sets the number of random sequences and
//! `PROP_SEED` replays one failing sequence; every failure message prints its seed.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::{CancelReason, Fill, OrderCancelled, OrderPlaced, PairMerged, PairMinted},
    instructions::ConfigUpdate,
    invariants::{check, payout, MarketSnapshot},
    state::{MarketStatus, Outcome, SIDE_ASK, SIDE_BID},
};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

/// splitmix64: tiny, deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct World {
    env: Env,
    users: Vec<Keypair>,
    markets: Vec<Pubkey>,
}

const START_USDC: u64 = 1_000 * USDC;

fn base_world() -> World {
    let (mut env, m680) = Env::with_market();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let users: Vec<Keypair> = (0..3).map(|_| env.user(START_USDC)).collect();
    // A non-zero taker fee, so fee paths are exercised and conserved.
    let admin = env.admin.insecure_clone();
    env.update_config(
        &admin,
        ConfigUpdate {
            fee_bps: Some(25),
            ..Default::default()
        },
    )
    .unwrap();
    // Pre-create every user's Yes/No ATAs so transfers between users always have a destination.
    let markets = vec![m680, m700];
    env.warp(OPEN);
    for m in &markets {
        for u in &users {
            // Everyone starts with 20 pairs, so asks and Sell No have inventory.
            env.mint_pair(u, m, 20).unwrap();
        }
        // A two-sided book to trade against.
        for (i, u) in users.iter().enumerate() {
            env.bid(u, m, 47 + i as u8, 5, TimeInForce::Gtc).unwrap();
            env.ask(u, m, 51 + i as u8, 5, TimeInForce::Gtc).unwrap();
        }
    }
    World {
        env,
        users,
        markets,
    }
}

fn total_usdc(w: &World) -> u64 {
    let mut t = w.env.token_balance(&w.env.fee_vault);
    for u in &w.users {
        t += w.env.token_balance(&ata(&u.pubkey(), &w.env.usdc_mint));
    }
    for m in &w.markets {
        t += w.env.token_balance(&w.env.market(m).vault);
        t += w.env.token_balance(&seeded(QUOTE_VAULT_SEED, m));
    }
    t
}

fn snapshot(w: &World, m: &Pubkey) -> MarketSnapshot {
    let mk = w.env.market(m);
    MarketSnapshot::of(
        &mk,
        w.env.token_balance(&mk.vault),
        w.env.mint_info(&mk.yes_mint).supply,
        w.env.mint_info(&mk.no_mint).supply,
    )
}

const TIMES: [i64; 5] = [MINT_OPEN - 10, MINT_OPEN, OPEN, CLOSE - 1, CLOSE + 60];

/// Net pairs created by one transaction, read from its PairMinted / PairMerged events.
fn pair_delta(meta: &litesvm::types::TransactionMetadata) -> i128 {
    let minted: u64 = events::<PairMinted>(meta).iter().map(|e| e.n).sum();
    let merged: u64 = events::<PairMerged>(meta).iter().map(|e| e.n).sum();
    minted as i128 - merged as i128
}

fn random_price(rng: &mut Rng) -> u8 {
    match rng.below(12) {
        0 => 0,
        1 => 100,
        _ => 46 + rng.below(8) as u8,
    }
}

fn random_qty(rng: &mut Rng) -> u64 {
    match rng.below(12) {
        0 => 0,
        1 => MAX_ORDER_QTY + 1,
        2 => 500 + rng.below(1_000),
        _ => 1 + rng.below(25),
    }
}

/// How often each kind of book operation succeeded, so the run proves it exercised them.
#[derive(Default, Debug)]
struct Stats {
    fills: u64,
    rests: u64,
    cancels: u64,
    buy_no: u64,
    sell_no: u64,
    withdraws: u64,
    settled: u64,
}

fn run_sequence(base: &World, seed: u64, steps: usize, st: &mut Stats) {
    let mut w = World {
        env: base.env.fork(),
        users: base.users.iter().map(|k| k.insecure_clone()).collect(),
        markets: base.markets.clone(),
    };
    let mut rng = Rng(seed);
    let total0 = total_usdc(&w);
    let mut pairs: Vec<u64> = w
        .markets
        .iter()
        .map(|m| w.env.market(m).pairs_outstanding)
        .collect();
    let owners: Vec<Pubkey> = w.users.iter().map(|u| u.pubkey()).collect();

    for step in 0..steps {
        let ctx = format!("PROP_SEED={seed} step {step}");
        let supplies_before: Vec<(u64, u64)> = w
            .markets
            .iter()
            .map(|m| (snapshot(&w, m).yes_supply, snapshot(&w, m).no_supply))
            .collect();
        let mi = rng.below(w.markets.len() as u64) as usize;
        let m = w.markets[mi];
        let ui = rng.below(w.users.len() as u64) as usize;
        let user = w.users[ui].insecure_clone();
        let mut delta: i128 = 0;
        let now = w.env.now();
        let paused = w.env.config().paused;
        let book_open = !paused && (OPEN..CLOSE).contains(&now);
        let op = rng.below(100);
        let label;
        if op < 20 {
            // mint_pair with a mix of small, zero, unaffordable and overflowing sizes.
            let n = match rng.below(10) {
                0 => 0,
                1 => u64::MAX / 1_000_000 + 1 + rng.below(1000),
                2 => 1_500 + rng.below(500),
                _ => 1 + rng.below(60),
            };
            let (usdc, _, _) = w.env.balances(&user.pubkey(), &m);
            let should = n > 0
                && !paused
                && (MINT_OPEN..CLOSE).contains(&now)
                && n.checked_mul(USDC).map(|c| c <= usdc).unwrap_or(false);
            let res = w.env.mint_pair(&user, &m, n);
            assert_eq!(
                res.is_ok(),
                should,
                "{ctx}: mint_pair({n}) ok={} expected {should}",
                res.is_ok()
            );
            if let Ok(meta) = &res {
                delta = pair_delta(meta);
                assert_eq!(delta, n as i128, "{ctx}: PairMinted");
            }
            label = "mint";
        } else if op < 30 {
            let n = if rng.below(8) == 0 {
                0
            } else {
                1 + rng.below(60)
            };
            let (_, yes, no) = w.env.balances(&user.pubkey(), &m);
            let should = n > 0 && yes >= n && no >= n;
            let res = w.env.merge_pair(&user, &m, n);
            assert_eq!(
                res.is_ok(),
                should,
                "{ctx}: merge_pair({n}) ok={} expected {should}",
                res.is_ok()
            );
            if let Ok(meta) = &res {
                delta = pair_delta(meta);
            }
            label = "merge";
        } else if op < 34 {
            // Donation straight into the vault (INV-04): must never brick mint, merge or redeem.
            let amt = 1 + rng.below(50_000);
            let vault = w.env.market(&m).vault;
            let from = ata(&user.pubkey(), &w.env.usdc_mint);
            if w.env.token_balance(&from) >= amt {
                let ix = spl_token::instruction::transfer(
                    &spl_token::ID,
                    &from,
                    &vault,
                    &user.pubkey(),
                    &[],
                    amt,
                )
                .unwrap();
                w.env.send(&[ix], &[&user]).unwrap();
            }
            label = "donate";
        } else if op < 38 {
            let admin = w.env.admin.insecure_clone();
            w.env.set_paused(&admin, !paused).unwrap();
            label = "pause";
        } else if op < 45 {
            let t = TIMES[rng.below(TIMES.len() as u64) as usize];
            w.env.warp(t);
            label = "warp";
        } else if op < 49 {
            // Peer-to-peer token transfer: moves tokens, never supply.
            let to = w.users[rng.below(w.users.len() as u64) as usize].pubkey();
            let mk = w.env.market(&m);
            let mint = if rng.below(2) == 0 {
                mk.yes_mint
            } else {
                mk.no_mint
            };
            let from = ata(&user.pubkey(), &mint);
            let bal = w.env.token_balance(&from);
            if bal > 0 {
                let amt = 1 + rng.below(bal);
                let ix = spl_token::instruction::transfer(
                    &spl_token::ID,
                    &from,
                    &ata(&to, &mint),
                    &user.pubkey(),
                    &[],
                    amt,
                )
                .unwrap();
                w.env.send(&[ix], &[&user]).unwrap();
            }
            label = "transfer";
        } else if op < 90 {
            // Order book operations (MER-20 to MER-25).
            let k = rng.below(41);
            let res = if k < 18 {
                let side = if rng.below(2) == 0 {
                    Side::Bid
                } else {
                    Side::Ask
                };
                let tif = match rng.below(3) {
                    0 => TimeInForce::Ioc,
                    1 => TimeInForce::Gtc,
                    _ => TimeInForce::PostOnly,
                };
                let (p, q) = (random_price(&mut rng), random_qty(&mut rng));
                let r = w.env.place(&user, &m, side, p, q, tif);
                if !book_open || !(1..=99).contains(&p) || q == 0 || q > MAX_ORDER_QTY {
                    assert!(r.is_err(), "{ctx}: place_order must fail (guards)");
                }
                r
            } else if k < 24 {
                let mine = w.env.book(&m).get().orders_of(&user.pubkey());
                if mine.is_empty() {
                    let ix = w.env.ix_cancel(&user.pubkey(), &m, Some(u64::MAX));
                    let r = w.env.send(&[ix], &[&user]);
                    assert!(r.is_err(), "{ctx}: cancel of a missing order must fail");
                    r
                } else {
                    let (_, _, id) = mine[rng.below(mine.len() as u64) as usize];
                    let r = w.env.cancel(&user, &m, id);
                    assert!(
                        r.is_ok(),
                        "{ctx}: owner cancel must succeed (always allowed)"
                    );
                    r
                }
            } else if k < 26 {
                let any_ledger = w.env.exists(&ledger_pda(&m, &user.pubkey()));
                let r = w.env.cancel_all(&user, &m);
                assert_eq!(r.is_ok(), any_ledger, "{ctx}: cancel_all");
                r
            } else if k < 30 {
                let (p, q) = (random_price(&mut rng), random_qty(&mut rng));
                let r = w
                    .env
                    .trade(&user, &m, TradeIx::BuyNoMarket { qty: q, min_yes: p });
                if !book_open {
                    assert!(r.is_err(), "{ctx}: buy_no_market must fail (guards)");
                }
                r
            } else if k < 34 {
                let (p, q) = (random_price(&mut rng), random_qty(&mut rng));
                let r = w.env.trade(
                    &user,
                    &m,
                    TradeIx::BuyNoLimit {
                        qty: q,
                        yes_price: p,
                    },
                );
                if !book_open {
                    assert!(r.is_err(), "{ctx}: buy_no_limit must fail (guards)");
                }
                r
            } else if k < 38 {
                let (p, q) = (random_price(&mut rng), random_qty(&mut rng));
                let no = w.env.balances(&user.pubkey(), &m).2;
                let r = w
                    .env
                    .trade(&user, &m, TradeIx::SellNo { qty: q, max_yes: p });
                if !book_open || q > no {
                    assert!(r.is_err(), "{ctx}: sell_no must fail");
                }
                r
            } else {
                let any_ledger = w.env.exists(&ledger_pda(&m, &user.pubkey()));
                let r = w.env.withdraw(&user, &m);
                assert_eq!(r.is_ok(), any_ledger, "{ctx}: withdraw is always allowed");
                if r.is_ok() {
                    let l = w.env.ledger(&m, &user.pubkey());
                    assert_eq!(
                        (l.free_usdc, l.free_yes),
                        (0, 0),
                        "{ctx}: withdraw zeroes free"
                    );
                }
                r
            };
            if let Ok(meta) = &res {
                delta = pair_delta(meta);
                st.fills += events::<Fill>(meta).len() as u64;
                st.rests += events::<OrderPlaced>(meta).len() as u64;
                st.cancels += events::<OrderCancelled>(meta)
                    .iter()
                    .filter(|e| e.reason == CancelReason::User)
                    .count() as u64;
                if (26..34).contains(&k) {
                    st.buy_no += 1;
                }
                if (34..38).contains(&k) && !events::<Fill>(meta).is_empty() {
                    st.sell_no += 1;
                }
                if k >= 38 {
                    st.withdraws += 1;
                }
            }
            label = "book";
        } else {
            label = "noop";
        }

        for (i, mk) in w.markets.iter().enumerate() {
            let s = snapshot(&w, mk);
            // INV-01, INV-02 (and 4: no outcome pre-settlement).
            assert_eq!(
                check(&s),
                None,
                "{ctx} after {label}: invariant broken {s:?}"
            );
            if i == mi {
                pairs[i] = (pairs[i] as i128 + delta) as u64;
            }
            assert_eq!(
                s.pairs_outstanding, pairs[i],
                "{ctx} after {label}: pairs differ from events"
            );
            // INV-06: supply moves only with PairMinted / PairMerged events.
            let (y0, n0) = supplies_before[i];
            let d = if i == mi { delta } else { 0 };
            assert_eq!(
                (s.yes_supply as i128, s.no_supply as i128),
                (y0 as i128 + d, n0 as i128 + d),
                "{ctx}: supply changed by {label} without an event"
            );
            // INV-05: book escrow covers locked + free; totals equal the ledgers.
            w.env.assert_book_escrow(mk, &owners);
            // Every Yes is in a wallet or the book; every No is in a wallet.
            let mkd = w.env.market(mk);
            let yes_held: u64 = owners
                .iter()
                .map(|o| w.env.token_balance(&ata(o, &mkd.yes_mint)))
                .sum::<u64>()
                + w.env.token_balance(&seeded(BASE_VAULT_SEED, mk));
            let no_held: u64 = owners
                .iter()
                .map(|o| w.env.token_balance(&ata(o, &mkd.no_mint)))
                .sum();
            assert_eq!(
                (yes_held, no_held),
                (s.yes_supply, s.no_supply),
                "{ctx}: tokens unaccounted"
            );
            // The book never rests crossed.
            let v = w.env.book(mk);
            if let (Some(b), Some(a)) = (v.get().best(SIDE_BID), v.get().best(SIDE_ASK)) {
                assert!(b < a, "{ctx}: crossed book {b} >= {a}");
            }
            // INV-08: no backwards status (only TRADING exists before settlement lands).
            assert_eq!(s.status, MarketStatus::Trading, "{ctx}: status");
        }
        // INV-07: USDC is conserved across wallets, vaults, book vaults and the fee vault.
        assert_eq!(
            total_usdc(&w),
            total0,
            "{ctx}: USDC not conserved after {label}"
        );
    }
    if seed % SETTLE_EVERY == 0 {
        settle_tail(&mut w, &mut rng, seed, total0, &owners);
        st.settled += 1;
    }
}

/// One sequence in `SETTLE_EVERY` ends with the whole settlement path (CON-05, MER-36):
/// record and finalize a random close, settle both strikes, prune to empty, close the
/// books, then every user withdraws and redeems everything. Afterwards no claim is left:
/// accounted = 0 and both supplies are 0, the vault holds only donations, and USDC is
/// conserved. Pause may be on: none of these steps is entry (D30).
fn settle_tail(w: &mut World, rng: &mut Rng, seed: u64, total0: u64, owners: &[Pubkey]) {
    let ctx = format!("PROP_SEED={seed} settlement");
    // Below, at and above each strike (680, 700).
    let cents = [67_500i64, 68_000, 69_000, 70_000, 71_000][rng.below(5) as usize];
    w.env.close_with(Update::meta(px(cents), 0));
    for m in w.markets.clone() {
        let donated =
            w.env.token_balance(&w.env.market(&m).vault) - w.env.market(&m).collateral_accounted;
        w.env
            .settle(&m)
            .unwrap_or_else(|e| panic!("{ctx}: settle {:?}", e.err));
        let s = snapshot(w, &m);
        assert_eq!(check(&s), None, "{ctx}: invariants after settle");
        let want = if cents * 1_000 >= w.env.market(&m).strike_cents as i64 * 1_000 {
            Outcome::Yes
        } else {
            Outcome::No
        };
        assert_eq!(s.outcome, want, "{ctx}: outcome");
        while w.env.book(&m).get().order_count > 0 {
            w.env
                .prune(&m, 32)
                .unwrap_or_else(|e| panic!("{ctx}: prune {:?}", e.err));
            w.env.assert_book_escrow(&m, owners);
        }
        w.env
            .close_book(&m)
            .unwrap_or_else(|e| panic!("{ctx}: close_book {:?}", e.err));
        for u in &w.users {
            w.env
                .withdraw(u, &m)
                .unwrap_or_else(|e| panic!("{ctx}: withdraw {:?}", e.err));
            let (_, y, n) = w.env.balances(&u.pubkey(), &m);
            if y + n > 0 {
                w.env
                    .redeem(u, &m, y, n)
                    .unwrap_or_else(|e| panic!("{ctx}: redeem {:?}", e.err));
            }
            assert_eq!(
                check(&snapshot(w, &m)),
                None,
                "{ctx}: invariants after redeem"
            );
        }
        let mk = w.env.market(&m);
        assert_eq!(mk.collateral_accounted, 0, "{ctx}: claims left");
        assert_eq!(w.env.mint_info(&mk.yes_mint).supply, 0, "{ctx}: Yes left");
        assert_eq!(w.env.mint_info(&mk.no_mint).supply, 0, "{ctx}: No left");
        assert_eq!(
            w.env.token_balance(&mk.vault),
            donated,
            "{ctx}: vault = donations"
        );
        assert_eq!(
            w.env.token_balance(&seeded(QUOTE_VAULT_SEED, &m)),
            0,
            "{ctx}: book USDC left"
        );
        assert_eq!(
            w.env.token_balance(&seeded(BASE_VAULT_SEED, &m)),
            0,
            "{ctx}: book Yes left"
        );
    }
    assert_eq!(total_usdc(w), total0, "{ctx}: USDC not conserved");
}

/// Run the settlement tail on one sequence in this many.
const SETTLE_EVERY: u64 = 4;

#[test]
fn inv_01_02_04_06_07_08_random_sequences() {
    let base = base_world();
    let mut st = Stats::default();
    if let Ok(seed) = std::env::var("PROP_SEED") {
        run_sequence(
            &base,
            seed.parse().expect("PROP_SEED must be a u64"),
            STEPS,
            &mut st,
        );
        return;
    }
    let n: u64 = std::env::var("PROP_SEQUENCES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let root = 0x4D45_5249_4449_414E; // "MERIDIAN"
    for i in 0..n {
        run_sequence(&base, root ^ i.wrapping_mul(0x9E37_79B9), STEPS, &mut st);
    }
    println!("{n} sequences: {st:?}");
    if n >= 200 {
        assert!(
            st.fills > 0
                && st.rests > 0
                && st.cancels > 0
                && st.buy_no > 0
                && st.sell_no > 0
                && st.withdraws > 0
                && st.settled > 0,
            "generator did not exercise every book path: {st:?}"
        );
    }
}

/// Steps per random sequence.
const STEPS: usize = 16;

#[test]
fn inv_03_post_settlement_accounting_check() {
    // Settlement instructions land in MER-32/34; the checker they will call is verified here.
    let s = |status, outcome, accounted, yes, no| MarketSnapshot {
        status,
        outcome,
        pairs_outstanding: 0,
        collateral_accounted: accounted,
        vault_amount: accounted + 7,
        yes_supply: yes,
        no_supply: no,
    };
    assert_eq!(
        check(&s(MarketStatus::Settled, Outcome::Yes, 10 * USDC, 10, 4)),
        None
    );
    assert_eq!(
        check(&s(MarketStatus::Settled, Outcome::No, 4 * USDC, 10, 4)),
        None
    );
    assert_eq!(
        check(&s(MarketStatus::Void, Outcome::Void, 7 * USDC, 10, 4)),
        None
    );
    assert_eq!(
        check(&s(MarketStatus::Settled, Outcome::Yes, 9 * USDC, 10, 4)),
        Some(3)
    );
    assert_eq!(
        check(&s(MarketStatus::Void, Outcome::Void, 14 * USDC, 10, 4)),
        Some(3)
    );
    assert_eq!(
        check(&s(MarketStatus::Settled, Outcome::None, 0, 0, 0)),
        Some(4)
    );
    // Invariant 1 wins over everything: vault short of accounted.
    let mut short = s(MarketStatus::Settled, Outcome::Yes, 10 * USDC, 10, 4);
    short.vault_amount = 10 * USDC - 1;
    assert_eq!(check(&short), Some(1));
    // Pre-settlement mismatch.
    let mut pre = s(MarketStatus::Trading, Outcome::None, 3 * USDC, 3, 3);
    pre.pairs_outstanding = 3;
    assert_eq!(check(&pre), None);
    pre.no_supply = 2;
    assert_eq!(check(&pre), Some(2));
}

#[test]
fn inv_04_donation_does_not_freeze_mint_or_merge() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    let eve = env.user(100 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 5).unwrap();
    let vault = env.market(&m).vault;
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&eve.pubkey(), &env.usdc_mint),
        &vault,
        &eve.pubkey(),
        &[],
        30_000,
    )
    .unwrap();
    env.send(&[ix], &[&eve]).unwrap();
    env.mint_pair(&bob, &m, 1).unwrap();
    env.merge_pair(&bob, &m, 6).unwrap();
    let mk = env.market(&m);
    assert_eq!(mk.collateral_accounted, 0);
    assert_eq!(
        env.token_balance(&vault),
        30_000,
        "donation stays as surplus"
    );
    // Settle + redeem with a donation present are asserted in MER-34.
}

#[test]
fn inv_09_no_arithmetic_overflow_at_extremes() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(u64::MAX);
    env.warp(OPEN);
    assert_err(env.mint_pair(&bob, &m, u64::MAX), MeridianError::Overflow);
    assert_err(
        env.mint_pair(&bob, &m, u64::MAX / USDC + 1),
        MeridianError::Overflow,
    );
    let max_n = u64::MAX / USDC;
    env.mint_pair(&bob, &m, max_n).unwrap();
    // pairs * $1 would now overflow on any further mint.
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::Overflow);
    assert_err(
        env.merge_pair(&bob, &m, u64::MAX),
        MeridianError::InsufficientTokens,
    );
    let mk = env.market(&m);
    assert_eq!(mk.pairs_outstanding, max_n);
    assert_eq!(mk.collateral_accounted, max_n * USDC);
}

#[test]
fn mnt_11_tokens_can_be_created_only_by_mint_paths() {
    let (mut env, m) = Env::with_market();
    let mk = env.market(&m);
    let eve = env.user(0);
    let dest = ata(&eve.pubkey(), &mk.yes_mint);
    let create = spl_associated_token_account::instruction::create_associated_token_account(
        &eve.pubkey(),
        &eve.pubkey(),
        &mk.yes_mint,
        &spl_token::ID,
    );
    env.send(&[create], &[&eve]).unwrap();
    // Any key trying to act as mint authority fails: the authority is the Market PDA.
    for signer in [
        eve.insecure_clone(),
        env.admin.insecure_clone(),
        env.creator.insecure_clone(),
        env.settler.insecure_clone(),
    ] {
        let ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            &mk.yes_mint,
            &dest,
            &signer.pubkey(),
            &[],
            1,
        )
        .unwrap();
        let payer = env.payer.insecure_clone();
        assert_fails(env.send(&[ix], &[&payer, &signer]));
    }
    assert_eq!(env.mint_info(&mk.yes_mint).supply, 0);
    // Only mint_pair and buy_no_* mint upward: the only mint_to CPIs in the program source.
    let srcs = [
        include_str!("../src/instructions/config.rs"),
        include_str!("../src/instructions/market.rs"),
        include_str!("../src/instructions/pause.rs"),
        include_str!("../src/instructions/ticker_day.rs"),
        include_str!("../src/instructions/cancel_withdraw.rs"),
        include_str!("../src/instructions/close.rs"),
        include_str!("../src/instructions/settle.rs"),
        include_str!("../src/instructions/cleanup.rs"),
        include_str!("../src/settlement.rs"),
        include_str!("../src/book.rs"),
    ];
    for s in srcs {
        assert!(
            !s.contains("mint_to("),
            "unexpected mint_to outside mint_merge.rs"
        );
    }
    assert_eq!(
        include_str!("../src/instructions/mint_merge.rs")
            .matches("token::mint_to(")
            .count(),
        1
    );
    // trade.rs: Yes and No once each in buy_no_market and in buy_no_limit; the helper in
    // token_ops.rs is the one other token::mint_to.
    let trade = include_str!("../src/instructions/trade.rs");
    assert_eq!(trade.matches("mint_to(").count(), 4);
    let bnm = &trade
        [trade.find("pub fn buy_no_market").unwrap()..trade.find("pub fn buy_no_limit").unwrap()];
    let bnl =
        &trade[trade.find("pub fn buy_no_limit").unwrap()..trade.find("pub fn sell_no").unwrap()];
    assert_eq!(
        (
            bnm.matches("mint_to(").count(),
            bnl.matches("mint_to(").count()
        ),
        (2, 2)
    );
    assert_eq!(
        include_str!("../src/instructions/token_ops.rs")
            .matches("token::mint_to(")
            .count(),
        1
    );
}

#[test]
fn set_11_payouts_sum_to_one_dollar_for_every_outcome() {
    // MER-30 adds the random (price, expo, strike) comparison; the payout table is fixed here.
    for o in [Outcome::Yes, Outcome::No, Outcome::Void] {
        let (y, n) = payout(o);
        assert_eq!(y + n, MICRO_USDC_PER_PAIR, "{o:?}");
    }
    assert_eq!(payout(Outcome::Yes), (1_000_000, 0));
    assert_eq!(payout(Outcome::No), (0, 1_000_000));
    assert_eq!(payout(Outcome::Void), (500_000, 500_000));
    // Never both and never neither for a binary outcome.
    for o in [Outcome::Yes, Outcome::No] {
        let (y, n) = payout(o);
        assert!((y == 0) ^ (n == 0));
    }
}

#[test]
fn con_09_config_is_read_only_on_hot_paths() {
    let (mut env, m680) = Env::with_market();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    for merge in [false, true] {
        let ix1 = env.ix_mint_merge(&a, &m680, 1, merge);
        let ix2 = env.ix_mint_merge(&b, &m700, 1, merge);
        for ix in [&ix1, &ix2] {
            let cfg = ix
                .accounts
                .iter()
                .find(|x| x.pubkey == config_pda())
                .unwrap();
            assert!(
                !cfg.is_writable,
                "Config must not be writable on mint/merge"
            );
            let td = ix
                .accounts
                .iter()
                .find(|x| x.pubkey == ticker_day_pda("META", DATE))
                .unwrap();
            assert!(
                !td.is_writable,
                "TickerDay must not be writable on mint/merge"
            );
        }
        let w1: Vec<_> = ix1
            .accounts
            .iter()
            .filter(|x| x.is_writable)
            .map(|x| x.pubkey)
            .collect();
        let w2: Vec<_> = ix2
            .accounts
            .iter()
            .filter(|x| x.is_writable)
            .map(|x| x.pubkey)
            .collect();
        assert!(
            w1.iter().all(|k| !w2.contains(k)),
            "different markets share a writable account"
        );
    }
}

// ---- Concurrency (Phase 2): LiteSVM runs one transaction at a time, which is how the
// runtime orders transactions that write the same Market and OrderBook in one slot. Both
// transactions are built against the same book state before either lands.

#[test]
fn con_02_two_takers_race_for_the_last_ask() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 0, 5);
    let alice = env.user(100 * USDC);
    let carol = env.user(100 * USDC);
    env.ask(&bob, &m, 60, 5, TimeInForce::Gtc).unwrap();
    let t = TradeIx::Place {
        side: Side::Bid,
        price: 60,
        qty: 5,
        tif: TimeInForce::Ioc,
    };
    let ia = env.ix_trade_auto(&alice.pubkey(), &m, &t);
    let ic = env.ix_trade_auto(&carol.pubkey(), &m, &t);
    env.send(&[ia], &[&alice]).unwrap();
    let meta = env.send(&[ic], &[&carol]).unwrap();
    assert_eq!(
        events::<OrderCancelled>(&meta)[0].reason,
        CancelReason::IocRemainder
    );
    assert_eq!(env.balances(&alice.pubkey(), &m).1, 5);
    assert_eq!(
        env.balances(&carol.pubkey(), &m),
        (100 * USDC, 0, 0),
        "carol gets 0, no overfill"
    );
    env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey(), carol.pubkey()]);
}

#[test]
fn con_03_maker_cancels_while_taker_fills() {
    for cancel_first in [true, false] {
        let (mut env, m) = Env::with_market();
        env.warp(OPEN);
        let bob = env.user_with_yes(&m, 0, 10);
        let alice = env.user(100 * USDC);
        env.ask(&bob, &m, 60, 10, TimeInForce::Gtc).unwrap();
        let id = env.book(&m).level(Side::Ask, 60)[0].1;
        let t = TradeIx::Place {
            side: Side::Bid,
            price: 60,
            qty: 10,
            tif: TimeInForce::Ioc,
        };
        let fill = env.ix_trade_auto(&alice.pubkey(), &m, &t);
        let cancel = env.ix_cancel(&bob.pubkey(), &m, Some(id));
        if cancel_first {
            env.send(&[cancel], &[&bob]).unwrap();
            env.send(&[fill], &[&alice]).unwrap();
            assert_eq!(
                env.balances(&alice.pubkey(), &m).1,
                0,
                "cancel then fill: none"
            );
            assert_eq!(env.ledger(&m, &bob.pubkey()).free_yes, 10);
        } else {
            env.send(&[fill], &[&alice]).unwrap();
            assert_err(env.send(&[cancel], &[&bob]), MeridianError::OrderNotFound);
            assert_eq!(
                env.balances(&alice.pubkey(), &m).1,
                10,
                "fill then cancel: no-op"
            );
            assert_eq!(
                env.ledger(&m, &bob.pubkey()).free_usdc,
                10 * 60 * MICRO_USDC_PER_CENT
            );
        }
        env.assert_book_escrow(&m, &[alice.pubkey(), bob.pubkey()]);
    }
}

#[test]
fn con_04_last_slot_before_close_fills_next_slot_halts() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(100 * USDC);
    let carol = env.user(100 * USDC);
    env.ask(&bob, &m, 60, 10, TimeInForce::Gtc).unwrap();
    let t = TradeIx::Place {
        side: Side::Bid,
        price: 60,
        qty: 5,
        tif: TimeInForce::Ioc,
    };
    let ia = env.ix_trade_auto(&alice.pubkey(), &m, &t);
    let ic = env.ix_trade_auto(&carol.pubkey(), &m, &t);
    env.warp(CLOSE - 1); // slot whose Clock says 15:59:59
    env.send(&[ia], &[&alice]).unwrap();
    env.warp(CLOSE); // next slot: 16:00:00
    assert_err(env.send(&[ic], &[&carol]), MeridianError::MarketHalted);
    assert_eq!(env.balances(&alice.pubkey(), &m).1, 5);
    assert_eq!(env.balances(&carol.pubkey(), &m).1, 0);
}

#[test]
fn con_08_buy_no_and_mint_contend_on_market_and_book() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let mm = env.user(100_000 * USDC);
    for p in 40..60u8 {
        env.bid(&mm, &m, p, 50, TimeInForce::Gtc).unwrap();
    }
    let users: Vec<Keypair> = (0..40).map(|_| env.user(100 * USDC)).collect();
    // Build every transaction first, then land them interleaved.
    let ixs: Vec<_> = users
        .iter()
        .enumerate()
        .map(|(i, u)| {
            if i % 2 == 0 {
                env.ix_trade_auto(
                    &u.pubkey(),
                    &m,
                    &TradeIx::BuyNoMarket {
                        qty: 3,
                        min_yes: 40,
                    },
                )
            } else {
                env.ix_mint_merge(&u.pubkey(), &m, 3, false)
            }
        })
        .collect();
    for (u, ix) in users.iter().zip(ixs) {
        env.send(&[ix], &[u]).unwrap();
    }
    let mk = env.market(&m);
    assert_eq!(mk.pairs_outstanding, 40 * 3);
    let s = MarketSnapshot::of(
        &mk,
        env.token_balance(&mk.vault),
        env.mint_info(&mk.yes_mint).supply,
        env.mint_info(&mk.no_mint).supply,
    );
    assert_eq!(check(&s), None);
    let mut owners: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
    owners.push(mm.pubkey());
    env.assert_book_escrow(&m, &owners);
}

#[test]
fn con_09_config_is_read_only_on_trade_paths() {
    let (mut env, m680) = Env::with_market();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let paths = [
        TradeIx::Place {
            side: Side::Bid,
            price: 50,
            qty: 1,
            tif: TimeInForce::Gtc,
        },
        TradeIx::BuyNoMarket { qty: 1, min_yes: 1 },
        TradeIx::BuyNoLimit {
            qty: 1,
            yes_price: 50,
        },
        TradeIx::SellNo {
            qty: 1,
            max_yes: 99,
        },
    ];
    for t in &paths {
        let ix1 = env.ix_trade(&a, &m680, t, &[]);
        let ix2 = env.ix_trade(&b, &m700, t, &[]);
        for ix in [&ix1, &ix2] {
            for k in [config_pda(), ticker_day_pda("META", DATE)] {
                let meta = ix.accounts.iter().find(|x| x.pubkey == k).unwrap();
                assert!(
                    !meta.is_writable,
                    "Config / TickerDay writable on a trade path"
                );
            }
        }
        let w1: Vec<_> = ix1
            .accounts
            .iter()
            .filter(|x| x.is_writable)
            .map(|x| x.pubkey)
            .collect();
        let w2: Vec<_> = ix2
            .accounts
            .iter()
            .filter(|x| x.is_writable)
            .map(|x| x.pubkey)
            .collect();
        assert!(
            w1.iter().all(|k| !w2.contains(k)),
            "different markets share a writable account"
        );
        // Fees accrue per market; the shared fee vault is not on any trade path.
        assert!(!ix1
            .accounts
            .iter()
            .any(|x| x.pubkey == env.config().fee_vault));
    }
}

#[test]
fn con_05_settle_and_redeem_race() {
    // Both built against the FINAL-but-unsettled state, landing in one slot.
    let (mut base, m) = Env::with_market();
    base.warp(OPEN);
    let alice = base.user(5 * USDC);
    base.mint_pair(&alice, &m, 5).unwrap();
    base.close_at(px(68_500));
    let settle = base.ix_settle_market(&m);
    let redeem = base.ix_redeem(&alice.pubkey(), &m, 5, 0);
    let payer = base.payer.insecure_clone();

    // Redeem first: fails cleanly, nothing paid; after settle lands it succeeds.
    let mut env = base.fork();
    assert_err(
        env.send(std::slice::from_ref(&redeem), &[&alice]),
        MeridianError::MarketNotSettled,
    );
    assert_eq!(env.balances(&alice.pubkey(), &m), (0, 5, 5));
    env.send(std::slice::from_ref(&settle), &[&payer]).unwrap();
    env.send(std::slice::from_ref(&redeem), &[&alice]).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (5 * USDC, 0, 5));

    // Settle first: redeem pays in full.
    let mut env = base.fork();
    env.send(&[settle], &[&payer]).unwrap();
    env.send(&[redeem], &[&alice]).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (5 * USDC, 0, 5));
}
