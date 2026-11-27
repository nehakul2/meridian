//! MER-14 · invariant assertions and property test harness.
//!
//! Matrix (Phase 1 scope): INV-01, INV-02, INV-03, INV-04, INV-06, INV-07, INV-08,
//! INV-09, MNT-11, SET-11, CON-09. The generator covers mint / merge / donate /
//! pause / clock / token transfer. MER-20 to MER-35 add their instructions to
//! `Op` (place, cancel, Buy No, Sell No, settle, prune, redeem, withdraw), which
//! is where INV-05, CON-02 to CON-06 and CON-08 are asserted.
//!
//! `PROP_SEQUENCES` (default 10,000) sets the number of random sequences and
//! `PROP_SEED` replays one failing sequence; every failure message prints its seed.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    invariants::{check, payout, MarketSnapshot},
    state::{MarketStatus, Outcome},
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
    // Pre-create every user's Yes/No ATAs so transfers between users always have a destination.
    let markets = vec![m680, m700];
    env.warp(OPEN);
    for m in &markets {
        for u in &users {
            env.mint_pair(u, m, 1).unwrap();
            env.merge_pair(u, m, 1).unwrap();
        }
    }
    World {
        env,
        users,
        markets,
    }
}

fn total_usdc(w: &World) -> u64 {
    let mut t = 0;
    for u in &w.users {
        t += w.env.token_balance(&ata(&u.pubkey(), &w.env.usdc_mint));
    }
    for m in &w.markets {
        t += w.env.token_balance(&w.env.market(m).vault);
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

fn run_sequence(base: &World, seed: u64, steps: usize) {
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
        let mut supply_may_change = false;
        let op = rng.below(100);
        let label;
        if op < 35 {
            // mint_pair with a mix of small, zero, unaffordable and overflowing sizes.
            let n = match rng.below(10) {
                0 => 0,
                1 => u64::MAX / 1_000_000 + 1 + rng.below(1000),
                2 => 1_500 + rng.below(500),
                _ => 1 + rng.below(60),
            };
            let (usdc, _, _) = w.env.balances(&user.pubkey(), &m);
            let now = w.env.now();
            let should = n > 0
                && !w.env.config().paused
                && now >= MINT_OPEN
                && now < CLOSE
                && n.checked_mul(USDC).map(|c| c <= usdc).unwrap_or(false);
            let res = w.env.mint_pair(&user, &m, n);
            assert_eq!(
                res.is_ok(),
                should,
                "{ctx}: mint_pair({n}) ok={} expected {should}",
                res.is_ok()
            );
            if res.is_ok() {
                pairs[mi] += n;
                supply_may_change = true;
            }
            label = "mint";
        } else if op < 60 {
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
            if res.is_ok() {
                pairs[mi] -= n;
                supply_may_change = true;
            }
            label = "merge";
        } else if op < 70 {
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
        } else if op < 78 {
            let admin = w.env.admin.insecure_clone();
            let p = !w.env.config().paused;
            w.env.set_paused(&admin, p).unwrap();
            label = "pause";
        } else if op < 88 {
            let t = TIMES[rng.below(TIMES.len() as u64) as usize];
            w.env.warp(t);
            label = "warp";
        } else {
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
        }

        for (i, mk) in w.markets.iter().enumerate() {
            let s = snapshot(&w, mk);
            // INV-01, INV-02 (and 4: no outcome pre-settlement).
            assert_eq!(
                check(&s),
                None,
                "{ctx} after {label}: invariant broken {s:?}"
            );
            assert!(s.vault_amount >= s.collateral_accounted, "{ctx}: INV-01");
            assert_eq!(s.pairs_outstanding, pairs[i], "{ctx}: pairs model drift");
            // INV-06: supply changes only in mint/merge.
            if !(supply_may_change && i == mi) {
                assert_eq!(
                    (s.yes_supply, s.no_supply),
                    supplies_before[i],
                    "{ctx}: supply changed by {label}"
                );
            }
            // INV-08: no backwards status (only TRADING exists before settlement lands).
            assert_eq!(s.status, MarketStatus::Trading, "{ctx}: status");
        }
        // INV-07: USDC is conserved across wallets and vaults.
        assert_eq!(
            total_usdc(&w),
            total0,
            "{ctx}: USDC not conserved after {label}"
        );
    }
}

#[test]
fn inv_01_02_04_06_07_08_random_sequences() {
    let base = base_world();
    if let Ok(seed) = std::env::var("PROP_SEED") {
        run_sequence(&base, seed.parse().expect("PROP_SEED must be a u64"), 12);
        return;
    }
    let n: u64 = std::env::var("PROP_SEQUENCES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let root = 0x4D45_5249_4449_414E; // "MERIDIAN"
    for i in 0..n {
        run_sequence(&base, root ^ i.wrapping_mul(0x9E37_79B9), 12);
    }
}

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
    // Only mint_pair (and later buy_no_*) mint upward: the only mint_to CPI in the program source.
    let srcs = [
        include_str!("../src/instructions/config.rs"),
        include_str!("../src/instructions/market.rs"),
        include_str!("../src/instructions/pause.rs"),
        include_str!("../src/instructions/ticker_day.rs"),
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
