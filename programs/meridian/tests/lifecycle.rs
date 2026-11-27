//! MER-36 · lifecycle and multi-user tests on LiteSVM.
//! Matrix: E2E-02, E2E-03, E2E-04 (program half; the service and devnet halves arrive
//! with Phases 4 to 7). Every scenario ends with collateral accounted = 0 after all
//! redeems and USDC conserved to the micro-unit across wallets, ledgers and vaults.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    state::{MarketStatus, Outcome, TickerDayStatus},
};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use TimeInForce::*;

const C: u64 = MICRO_USDC_PER_CENT;

/// Every micro-USDC in the system: wallets, the collateral vault, both book vaults
/// (ledger balances and fees live there) and the fee and bond vaults.
fn total_usdc(env: &Env, users: &[&Keypair], m: &Pubkey) -> u64 {
    let mk = env.market(m);
    let mut t: u64 = users.iter().map(|u| env.usdc_of(&u.pubkey())).sum();
    t += env.token_balance(&mk.vault);
    t += env.token_balance(&seeded(QUOTE_VAULT_SEED, m));
    t += env.token_balance(&env.fee_vault.clone());
    t += env.token_balance(&env.config().bond_vault);
    t
}

/// Halt, record, finalize, settle, prune to empty, close the book; then everyone
/// withdraws and redeems everything they hold. Asserts the end state.
fn settle_and_redeem_all(env: &mut Env, m: &Pubkey, users: &[&Keypair], price: i64) {
    env.close_at(price);
    env.settle(m).unwrap();
    while env.book(m).get().order_count > 0 {
        env.prune(m, 32).unwrap();
    }
    env.close_book(m).unwrap();
    for u in users {
        if env.exists(&ledger_pda(m, &u.pubkey())) {
            env.withdraw(u, m).unwrap();
        }
        let (_, y, n) = env.balances(&u.pubkey(), m);
        if y + n > 0 {
            env.redeem(u, m, y, n).unwrap();
        }
    }
    let mk = env.market(m);
    assert_eq!(mk.status, MarketStatus::Settled);
    assert_eq!(mk.collateral_accounted, 0, "every claim paid");
    assert_eq!(env.token_balance(&mk.vault), 0);
    assert_eq!(env.mint_info(&mk.yes_mint).supply, 0);
    assert_eq!(env.mint_info(&mk.no_mint).supply, 0);
    assert_eq!(
        env.token_balance(&seeded(QUOTE_VAULT_SEED, m)),
        0,
        "no USDC left in the book"
    );
    assert_eq!(
        env.token_balance(&seeded(BASE_VAULT_SEED, m)),
        0,
        "no Yes left in the book"
    );
}

#[test]
fn full_lifecycle_create_to_redeem() {
    let (mut env, m) = Env::with_market();
    env.warp(MINT_OPEN);
    let bob = env.user(1_000 * USDC);
    let alice = env.user(1_000 * USDC);
    let users = [&bob, &alice];
    let start = total_usdc(&env, &users, &m);
    env.mint_pair(&bob, &m, 100).unwrap();
    env.warp(OPEN);
    env.ask(&bob, &m, 55, 40, Gtc).unwrap();
    env.bid(&alice, &m, 55, 25, Ioc).unwrap();
    // Halt at close: no more trading, resting orders frozen.
    env.warp(CLOSE);
    assert_err(env.bid(&alice, &m, 55, 1, Ioc), MeridianError::MarketHalted);
    settle_and_redeem_all(&mut env, &m, &users, px(68_500));
    assert_eq!(
        env.ticker_day(&ticker_day_pda("META", DATE)).status,
        TickerDayStatus::Final
    );
    assert_eq!(total_usdc(&env, &users, &m), start, "USDC conserved");
    // alice paid 25 x 55c and redeemed 25 winning Yes.
    assert_eq!(
        env.usdc_of(&alice.pubkey()),
        1_000 * USDC - 25 * 55 * C + 25 * USDC
    );
    assert_eq!(
        env.usdc_of(&bob.pubkey()),
        1_000 * USDC + 25 * 55 * C - 25 * USDC
    );
}

#[test]
fn e2e_02_all_four_trade_paths_in_one_scenario() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 1_000 * USDC, 100);
    let alice = env.user(100 * USDC);
    let carol = env.user(100 * USDC);
    let users = [&bob, &alice, &carol];
    let start = total_usdc(&env, &users, &m);
    env.ask(&bob, &m, 60, 50, Gtc).unwrap();
    env.bid(&bob, &m, 40, 50, Gtc).unwrap();

    // 1. alice Buy Yes 10 at 60, 2. Sell Yes 10 at 40.
    env.bid(&alice, &m, 60, 10, Ioc).unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (100 * USDC - 600 * C, 10, 0)
    );
    env.ask(&alice, &m, 40, 10, Ioc).unwrap();
    assert_eq!(
        env.balances(&alice.pubkey(), &m),
        (100 * USDC - 200 * C, 0, 0),
        "flat, -$2.00"
    );
    // 3. carol Buy No 10 (sells Yes into the 40 bid: No costs 60c), 4. Sell No 10
    // (buys Yes at 60: No sells for 40c).
    env.trade(
        &carol,
        &m,
        TradeIx::BuyNoMarket {
            qty: 10,
            min_yes: 40,
        },
    )
    .unwrap();
    assert_eq!(
        env.balances(&carol.pubkey(), &m),
        (100 * USDC - 600 * C, 0, 10)
    );
    env.trade(
        &carol,
        &m,
        TradeIx::SellNo {
            qty: 10,
            max_yes: 60,
        },
    )
    .unwrap();
    assert_eq!(
        env.balances(&carol.pubkey(), &m),
        (100 * USDC - 200 * C, 0, 0),
        "flat, -$2.00"
    );

    // bob sold 20 at 60 and bought 20 at 40 in his ledger.
    let l = env.ledger(&m, &bob.pubkey());
    assert_eq!((l.free_usdc, l.free_yes), (20 * 60 * C, 20));
    env.assert_book_escrow(&m, &[bob.pubkey(), alice.pubkey(), carol.pubkey()]);

    settle_and_redeem_all(&mut env, &m, &users, px(67_000));
    assert_eq!(total_usdc(&env, &users, &m), start, "USDC conserved");
    // bob deposited $1,100: -$100 minted, +$12 sold, -$8 bought, +$100 redeemed.
    assert_eq!(env.usdc_of(&bob.pubkey()), 1_100 * USDC + 400 * C);
    assert_eq!(env.usdc_of(&alice.pubkey()), 100 * USDC - 200 * C);
    assert_eq!(env.usdc_of(&carol.pubkey()), 100 * USDC - 200 * C);
}

#[test]
fn e2e_03_maker_mints_and_quotes_taker_takes_both_redeem() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user(10_000 * USDC);
    let alice = env.user(1_000 * USDC);
    let users = [&bob, &alice];
    let start = total_usdc(&env, &users, &m);
    // 1. bob mints 100 and asks 60 x 100. 2. alice buys 50.
    env.mint_pair(&bob, &m, 100).unwrap();
    env.ask(&bob, &m, 60, 100, Gtc).unwrap();
    env.bid(&alice, &m, 60, 50, Ioc).unwrap();
    // 3. Settle YES at 685; prune returns bob's 50 unsold Yes.
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    assert_eq!(env.market(&m).outcome, Outcome::Yes);
    env.prune(&m, 10).unwrap();
    let l = env.ledger(&m, &bob.pubkey());
    assert_eq!(
        (l.free_yes, l.locked_yes, l.free_usdc),
        (50, 0, 50 * 60 * C)
    );
    // 4. bob withdraws and redeems 50 Yes + 100 No; alice redeems 50 Yes.
    env.close_book(&m).unwrap();
    env.withdraw(&bob, &m).unwrap();
    assert_eq!(
        env.balances(&bob.pubkey(), &m),
        (9_900 * USDC + 30 * USDC, 50, 100)
    );
    env.redeem(&bob, &m, 50, 100).unwrap();
    env.redeem(&alice, &m, 50, 0).unwrap();
    // alice +50 - 30 = +$20. bob paid $100, received $30 + $50: net -$20.
    assert_eq!(env.usdc_of(&alice.pubkey()), 1_000 * USDC + 20 * USDC);
    assert_eq!(env.usdc_of(&bob.pubkey()), 10_000 * USDC - 20 * USDC);
    let mk = env.market(&m);
    assert_eq!(
        (mk.collateral_accounted, env.token_balance(&mk.vault)),
        (0, 0)
    );
    assert_eq!(total_usdc(&env, &users, &m), start);
}

#[test]
fn e2e_04_degraded_path_oracle_fails_override_settles() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 1_000 * USDC, 40);
    let alice = env.user(100 * USDC);
    let users = [&bob, &alice];
    let start = total_usdc(&env, &users, &m);
    env.ask(&bob, &m, 30, 40, Gtc).unwrap();
    env.bid(&alice, &m, 30, 20, Ioc).unwrap();
    // 1-2. The settler retries every 30 s to close + 15 min; every reference update has
    // a 15 bps confidence, so nothing records.
    let mut t = CLOSE + 300;
    while t <= CLOSE + 900 {
        env.warp(t);
        assert_err(
            env.record_close(&Update::meta(px(68_500), 15).at(CLOSE + 1)),
            MeridianError::ConfidenceTooWide,
        );
        t += 30;
    }
    // 3-4. The multisig signs the override at close + 30 min.
    let admin = env.admin.insecure_clone();
    env.warp(CLOSE + 1_799);
    assert_err(
        env.admin_settle_as(&admin, 68_512_000),
        MeridianError::OverrideTooEarly,
    );
    env.warp(CLOSE + 1_800);
    env.admin_settle_as(&admin, 68_512_000).unwrap();
    // 5. Final after the dispute window; crank and redeem.
    env.warp(CLOSE + 1_800 + 1_200);
    env.finalize_close().unwrap();
    env.settle(&m).unwrap();
    let mk = env.market(&m);
    assert_eq!((mk.outcome, mk.settle_price), (Outcome::Yes, 68_512_000));
    while env.book(&m).get().order_count > 0 {
        env.prune(&m, 32).unwrap();
    }
    env.close_book(&m).unwrap();
    for u in users {
        if env.exists(&ledger_pda(&m, &u.pubkey())) {
            env.withdraw(u, &m).unwrap();
        }
        let (_, y, n) = env.balances(&u.pubkey(), &m);
        env.redeem(u, &m, y, n).unwrap();
    }
    // alice paid 20 x 30c and redeemed 20 winners.
    assert_eq!(
        env.usdc_of(&alice.pubkey()),
        100 * USDC - 600 * C + 20 * USDC
    );
    let mk = env.market(&m);
    assert_eq!(
        (mk.collateral_accounted, env.token_balance(&mk.vault)),
        (0, 0)
    );
    assert_eq!(total_usdc(&env, &users, &m), start);
}

#[test]
fn buy_no_limit_through_settlement_with_a_partial_fill() {
    // D15 end to end: a BUY_NO ask partly fills, the rest is converted by prune.
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let carol = env.user(100 * USDC);
    let alice = env.user(100 * USDC);
    let users = [&carol, &alice];
    let start = total_usdc(&env, &users, &m);
    env.trade(
        &carol,
        &m,
        TradeIx::BuyNoLimit {
            qty: 10,
            yes_price: 45,
        },
    )
    .unwrap();
    env.bid(&alice, &m, 45, 4, Ioc).unwrap(); // 4 of carol's Yes sell at 45
    assert_eq!(env.ledger(&m, &carol.pubkey()).free_usdc, 4 * 45 * C);
    settle_and_redeem_all(&mut env, &m, &users, px(67_500)); // NO wins
                                                             // carol: -$10 mint, +$1.80 for 4 Yes, +$6 for 6 converted pairs, +$4 for 4 No.
    assert_eq!(env.usdc_of(&carol.pubkey()), 100 * USDC + 180 * C);
    assert_eq!(env.usdc_of(&alice.pubkey()), 100 * USDC - 180 * C);
    assert_eq!(total_usdc(&env, &users, &m), start);
}
