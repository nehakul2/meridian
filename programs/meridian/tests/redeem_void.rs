//! MER-34 · redeem and void_market (D20, D30, A24, A27).
//! Matrix: RED-01 to RED-08, SEC-04, POS-08.
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::{MarketVoided, Redeemed},
    state::{MarketStatus, Outcome},
};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

fn give(env: &mut Env, from: &Keypair, to: &Pubkey, mint: &Pubkey, n: u64) {
    let create =
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &from.pubkey(),
            to,
            mint,
            &spl_token::ID,
        );
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&from.pubkey(), mint),
        &ata(to, mint),
        &from.pubkey(),
        &[],
        n,
    )
    .unwrap();
    env.send(&[create, ix], &[from]).unwrap();
}

struct World {
    env: Env,
    m: Pubkey,
    alice: Keypair,
    bob: Keypair,
    carol: Keypair,
}

/// alice 20 Yes, carol 20 No (from alice), bob 5 Yes + 5 No. Settled at `price`.
fn settled(price: i64) -> World {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(20 * USDC);
    let bob = env.user(5 * USDC);
    let carol = env.user(0);
    env.mint_pair(&alice, &m, 20).unwrap();
    env.mint_pair(&bob, &m, 5).unwrap();
    let no = env.market(&m).no_mint;
    give(&mut env, &alice, &carol.pubkey(), &no, 20);
    env.close_at(price);
    env.settle(&m).unwrap();
    World {
        env,
        m,
        alice,
        bob,
        carol,
    }
}

#[test]
fn red_01_winning_yes_redeems_one_dollar_each() {
    let mut w = settled(px(68_500));
    let accounted = w.env.market(&w.m).collateral_accounted;
    let meta = w.env.redeem(&w.alice, &w.m, 20, 0).unwrap();
    assert_eq!(w.env.balances(&w.alice.pubkey(), &w.m), (20_000_000, 0, 0));
    assert_eq!(
        w.env.market(&w.m).collateral_accounted,
        accounted - 20_000_000
    );
    let ev = &events::<Redeemed>(&meta)[0];
    assert_eq!(
        (ev.owner, ev.yes_n, ev.no_n, ev.paid),
        (w.alice.pubkey(), 20, 0, 20_000_000)
    );
}

#[test]
fn red_02_losing_tokens_burn_for_zero() {
    let mut w = settled(px(68_500));
    let vault = w.env.market(&w.m).vault;
    let before = w.env.token_balance(&vault);
    w.env.redeem(&w.carol, &w.m, 0, 10).unwrap();
    assert_eq!(w.env.balances(&w.carol.pubkey(), &w.m), (0, 0, 10));
    assert_eq!(w.env.token_balance(&vault), before);
}

#[test]
fn red_03_mixed_redeem_pays_only_winners() {
    let mut w = settled(px(68_500));
    let no_supply = w.env.mint_info(&w.env.market(&w.m).no_mint).supply;
    w.env.redeem(&w.bob, &w.m, 5, 5).unwrap();
    assert_eq!(w.env.balances(&w.bob.pubkey(), &w.m), (5_000_000, 0, 0));
    assert_eq!(
        w.env.mint_info(&w.env.market(&w.m).no_mint).supply,
        no_supply - 5
    );
}

#[test]
fn red_03_settled_no_pays_no_holders() {
    let mut w = settled(px(67_500));
    w.env.redeem(&w.bob, &w.m, 5, 5).unwrap();
    assert_eq!(w.env.usdc_of(&w.bob.pubkey()), 5_000_000);
    w.env.redeem(&w.carol, &w.m, 0, 20).unwrap();
    assert_eq!(w.env.usdc_of(&w.carol.pubkey()), 20_000_000);
    w.env.redeem(&w.alice, &w.m, 20, 0).unwrap();
    assert_eq!(w.env.usdc_of(&w.alice.pubkey()), 0);
    assert_eq!(w.env.market(&w.m).collateral_accounted, 0);
}

#[test]
fn red_04_redeem_before_settlement_fails() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(5 * USDC);
    env.mint_pair(&alice, &m, 5).unwrap();
    env.warp(CLOSE + 60);
    assert_err(
        env.redeem(&alice, &m, 5, 5),
        MeridianError::MarketNotSettled,
    );
    // Still not after a provisional record.
    env.record_close(&Update::meta(px(68_500), 1)).unwrap();
    assert_err(
        env.redeem(&alice, &m, 5, 0),
        MeridianError::MarketNotSettled,
    );
}

#[test]
fn red_05_redeem_more_than_balance_fails() {
    let mut w = settled(px(68_500));
    let yes = w.env.market(&w.m).yes_mint;
    give(&mut w.env, &w.alice, &w.bob.pubkey(), &yes, 15); // alice keeps 5
    assert_err(
        w.env.redeem(&w.alice, &w.m, 10, 0),
        MeridianError::InsufficientTokens,
    );
    assert_eq!(
        w.env.balances(&w.alice.pubkey(), &w.m).1,
        5,
        "nothing burned"
    );
    assert_err(
        w.env.redeem(&w.alice, &w.m, 0, 0),
        MeridianError::ZeroQuantity,
    );
}

#[test]
fn red_06_redeemable_indefinitely_after_book_closed() {
    let mut w = settled(px(68_500));
    w.env.close_book(&w.m).unwrap();
    w.env.warp(CLOSE + 400 * 86_400);
    w.env.redeem(&w.alice, &w.m, 20, 0).unwrap();
    assert_eq!(w.env.usdc_of(&w.alice.pubkey()), 20_000_000);
}

#[test]
fn red_07_void_market_pays_half_per_token() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m, 10).unwrap();
    let admin = env.admin.insecure_clone();
    let eve = env.user(0);
    assert_err(env.void_market_as(&eve, &m), MeridianError::Unauthorized);
    let creator = env.creator.insecure_clone();
    assert_err(
        env.void_market_as(&creator, &m),
        MeridianError::Unauthorized,
    );
    let meta = env.void_market_as(&admin, &m).unwrap();
    assert_eq!(events::<MarketVoided>(&meta)[0].market, m);
    let mk = env.market(&m);
    assert_eq!((mk.status, mk.outcome), (MarketStatus::Void, Outcome::Void));
    // Voiding stops entry at once.
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::MarketNotTrading);
    env.redeem(&bob, &m, 10, 10).unwrap();
    assert_eq!(env.usdc_of(&bob.pubkey()), 10_000_000, "20 x $0.50");
    assert_eq!(env.market(&m).collateral_accounted, 0);
    assert_err(env.void_market_as(&admin, &m), MeridianError::MarketSettled);
}

#[test]
fn red_08_void_blocked_once_traded() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let bob = env.user_with_yes(&m, 0, 10);
    let alice = env.user(10 * USDC);
    env.ask(&bob, &m, 40, 10, TimeInForce::Gtc).unwrap();
    env.bid(&alice, &m, 40, 1, TimeInForce::Ioc).unwrap();
    assert_eq!(env.market(&m).total_trades, 1);
    let admin = env.admin.insecure_clone();
    assert_err(
        env.void_market_as(&admin, &m),
        MeridianError::MarketHasTrades,
    );
}

#[test]
fn void_blocked_after_settlement() {
    let mut w = settled(px(68_500));
    let admin = w.env.admin.insecure_clone();
    assert_err(
        w.env.void_market_as(&admin, &w.m),
        MeridianError::MarketSettled,
    );
}

#[test]
fn sec_04_redeem_with_tokens_of_another_market_fails() {
    let (mut env, m680) = Env::with_market();
    env.warp(OPEN);
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let alice = env.user(10 * USDC);
    env.mint_pair(&alice, &m700, 5).unwrap();
    env.mint_pair(&alice, &m680, 1).unwrap();
    env.close_at(px(71_000));
    env.settle(&m680).unwrap();
    env.settle(&m700).unwrap();
    let k = env.market(&m700);
    let ix = env.ix_redeem_with(
        &alice.pubkey(),
        &m680,
        ata(&alice.pubkey(), &k.yes_mint),
        ata(&alice.pubkey(), &k.no_mint),
        5,
        0,
    );
    assert_fails(env.send(&[ix], &[&alice]));
    assert_eq!(env.balances(&alice.pubkey(), &m700).1, 5);
}

#[test]
fn redeem_works_while_paused() {
    let mut w = settled(px(68_500));
    let admin = w.env.admin.insecure_clone();
    w.env.set_paused(&admin, true).unwrap();
    w.env.redeem(&w.alice, &w.m, 20, 0).unwrap();
    assert_eq!(w.env.usdc_of(&w.alice.pubkey()), 20_000_000);
}

#[test]
fn partial_redeems_drain_accounted_to_exactly_zero() {
    let mut w = settled(px(68_500));
    for (k, y, n) in [
        (&w.alice, 7u64, 0u64),
        (&w.carol, 0, 20),
        (&w.bob, 2, 1),
        (&w.alice, 13, 0),
        (&w.bob, 3, 4),
    ] {
        let k = k.insecure_clone();
        w.env.redeem(&k, &w.m, y, n).unwrap();
    }
    let mk = w.env.market(&w.m);
    assert_eq!(mk.collateral_accounted, 0);
    assert_eq!(w.env.token_balance(&mk.vault), 0);
    assert_eq!(w.env.mint_info(&mk.yes_mint).supply, 0);
    assert_eq!(w.env.mint_info(&mk.no_mint).supply, 0);
}

#[test]
fn pos_08_tokens_received_by_transfer_merge_and_redeem() {
    let (mut env, m) = Env::with_market();
    env.warp(OPEN);
    let alice = env.user(10 * USDC);
    let carol = env.user(10 * USDC);
    env.mint_pair(&alice, &m, 10).unwrap();
    env.mint_pair(&carol, &m, 10).unwrap();
    let no = env.market(&m).no_mint;
    // alice gives her own No away, then receives 5 No from carol.
    give(&mut env, &alice, &carol.pubkey(), &no, 10);
    give(&mut env, &carol, &alice.pubkey(), &no, 5);
    env.merge_pair(&alice, &m, 5).unwrap();
    assert_eq!(env.balances(&alice.pubkey(), &m), (5 * USDC, 5, 0));
    env.close_at(px(68_500));
    env.settle(&m).unwrap();
    env.redeem(&alice, &m, 5, 0).unwrap();
    assert_eq!(env.usdc_of(&alice.pubkey()), 10 * USDC);
}

#[test]
fn sec_01_redeem_with_another_markets_mints_or_vault_fails() {
    let (mut env, m680) = Env::with_market();
    env.warp(OPEN);
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let alice = env.user(10 * USDC);
    env.mint_pair(&alice, &m680, 5).unwrap();
    env.mint_pair(&alice, &m700, 5).unwrap();
    env.close_at(px(71_000));
    env.settle(&m680).unwrap();
    env.settle(&m700).unwrap();
    let other = env.market(&m700);
    // Swap in M700's vault, then its Yes mint, then its No mint (Redeem accounts 3, 4, 5).
    for (i, k) in [
        (3usize, other.vault),
        (4, other.yes_mint),
        (5, other.no_mint),
    ] {
        let mut ix = env.ix_redeem(&alice.pubkey(), &m680, 5, 0);
        ix.accounts[i].pubkey = k;
        assert_err(env.send(&[ix], &[&alice]), MeridianError::AccountMismatch);
    }
    assert_eq!(env.usdc_of(&alice.pubkey()), 0);
}

#[test]
fn con_09_config_is_read_only_on_redeem() {
    let (mut env, m680) = Env::with_market();
    env.create_market("META", DATE, 70_000).unwrap();
    let m700 = market_pda("META", DATE, 70_000);
    let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
    let ix1 = env.ix_redeem(&a, &m680, 1, 0);
    let ix2 = env.ix_redeem(&b, &m700, 1, 0);
    for ix in [&ix1, &ix2] {
        let cfg = ix
            .accounts
            .iter()
            .find(|x| x.pubkey == config_pda())
            .unwrap();
        assert!(!cfg.is_writable, "Config must not be writable on redeem");
    }
    let w1: Vec<_> = ix1
        .accounts
        .iter()
        .filter(|x| x.is_writable)
        .map(|x| x.pubkey)
        .collect();
    assert!(
        ix2.accounts
            .iter()
            .filter(|x| x.is_writable)
            .all(|x| !w1.contains(&x.pubkey)),
        "redeems on different markets share a writable account"
    );
}
