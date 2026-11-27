//! MER-13 · mint_pair and merge_pair with accounted collateral.
//! Matrix: MNT-01 .. MNT-10.
mod common;

use common::*;
use meridian::{
    errors::MeridianError,
    events::{PairMerged, PairMinted, Via},
    state::{MarketStatus, Outcome},
};
use solana_sdk::signature::Signer;

fn market_counters(env: &Env, m: &solana_sdk::pubkey::Pubkey) -> (u64, u64, u64) {
    let mk = env.market(m);
    (
        mk.pairs_outstanding,
        mk.collateral_accounted,
        env.token_balance(&mk.vault),
    )
}

#[test]
fn mnt_01_mint_one_pair_for_one_dollar() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(10_000 * USDC);
    env.warp(OPEN);
    let meta = env.mint_pair(&bob, &m, 1).unwrap();
    assert_eq!(
        env.balances(&bob.pubkey(), &m),
        (10_000 * USDC - USDC, 1, 1)
    );
    assert_eq!(market_counters(&env, &m), (1, USDC, USDC));
    assert_eq!(env.market(&m).total_minted, 1);
    let ev = events::<PairMinted>(&meta);
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0].owner, ev[0].n, ev[0].via, ev[0].market),
        (bob.pubkey(), 1, Via::Direct, m)
    );
    assert_eq!(ev[0].seq, 2, "MarketCreated was seq 1");
}

#[test]
fn mnt_02_mint_n_pairs_scales_exactly() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(10_000 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 5_000).unwrap();
    assert_eq!(
        env.balances(&bob.pubkey(), &m),
        (5_000 * USDC, 5_000, 5_000)
    );
    assert_eq!(
        market_counters(&env, &m),
        (5_000, 5_000_000_000, 5_000_000_000)
    );
}

#[test]
fn mnt_03_mint_zero_rejected() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(10 * USDC);
    env.warp(OPEN);
    assert_err(env.mint_pair(&bob, &m, 0), MeridianError::ZeroQuantity);
    assert_eq!(market_counters(&env, &m), (0, 0, 0));
}

#[test]
fn mnt_04_mint_with_insufficient_usdc_fails_atomically() {
    let (mut env, m) = Env::with_market();
    let eve = env.user(USDC / 2);
    env.warp(OPEN);
    assert_fails(env.mint_pair(&eve, &m, 1));
    assert_eq!(env.balances(&eve.pubkey(), &m), (USDC / 2, 0, 0));
    assert_eq!(market_counters(&env, &m), (0, 0, 0));
    let mk = env.market(&m);
    assert_eq!(env.mint_info(&mk.yes_mint).supply, 0);
}

#[test]
fn mnt_05_mint_allowed_before_book_opens() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    env.warp(MINT_OPEN + 900); // 08:45 ET
    env.mint_pair(&bob, &m, 10).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m), (90 * USDC, 10, 10));
    // place_order before open_time (MARKET_NOT_OPEN) is covered by MER-20.
}

#[test]
fn mnt_06_mint_rejected_at_and_after_close_time() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    env.warp(CLOSE);
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::MarketClosed);
    env.warp(CLOSE + 3_600);
    assert_err(env.mint_pair(&bob, &m, 1), MeridianError::MarketClosed);
    assert_eq!(market_counters(&env, &m), (0, 0, 0));
}

#[test]
fn mnt_07_merge_burns_pairs_for_one_dollar_each() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 10).unwrap();
    let meta = env.merge_pair(&bob, &m, 4).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m), (94 * USDC, 6, 6));
    assert_eq!(market_counters(&env, &m), (6, 6 * USDC, 6 * USDC));
    let mk = env.market(&m);
    assert_eq!(env.mint_info(&mk.yes_mint).supply, 6);
    assert_eq!(env.mint_info(&mk.no_mint).supply, 6);
    let ev = events::<PairMerged>(&meta);
    assert_eq!(
        (ev[0].owner, ev[0].n, ev[0].via),
        (bob.pubkey(), 4, Via::Direct)
    );
}

#[test]
fn mnt_08_merge_more_than_smaller_balance_fails() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    let carol = env.user(0);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 10).unwrap();
    // Move 7 No to carol: bob holds 10 Yes, 3 No.
    let mk = env.market(&m);
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        &ata(&bob.pubkey(), &mk.no_mint),
        &ata(&carol.pubkey(), &mk.no_mint),
        &bob.pubkey(),
        &[],
        7,
    )
    .unwrap();
    let create = spl_associated_token_account::instruction::create_associated_token_account(
        &bob.pubkey(),
        &carol.pubkey(),
        &mk.no_mint,
        &spl_token::ID,
    );
    env.send(&[create, ix], &[&bob]).unwrap();
    assert_err(
        env.merge_pair(&bob, &m, 4),
        MeridianError::InsufficientTokens,
    );
    assert_eq!(env.balances(&bob.pubkey(), &m), (90 * USDC, 10, 3));
    env.merge_pair(&bob, &m, 3).unwrap();
}

#[test]
fn mnt_09_merge_after_settlement_is_rejected() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 2).unwrap();
    // settle_market lands in MER-32; put the market into a consistent SETTLED state.
    env.warp(CLOSE + 1_800);
    env.force_market(&m, |mk| {
        mk.status = MarketStatus::Settled;
        mk.outcome = Outcome::Yes;
    });
    assert_err(env.merge_pair(&bob, &m, 1), MeridianError::MarketSettled);
    env.force_market(&m, |mk| {
        mk.status = MarketStatus::Void;
        mk.outcome = Outcome::Void;
    });
    assert_err(env.merge_pair(&bob, &m, 1), MeridianError::MarketSettled);
    assert_eq!(env.balances(&bob.pubkey(), &m), (98 * USDC, 2, 2));
}

#[test]
fn mnt_10_merge_works_after_halt_before_settlement() {
    let (mut env, m) = Env::with_market();
    let bob = env.user(100 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 2).unwrap();
    env.warp(CLOSE + 60); // 16:01, ticker-day still OPEN
    env.merge_pair(&bob, &m, 1).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m), (99 * USDC, 1, 1));
}

#[test]
fn mnt_merge_zero_and_mint_on_wrong_accounts_rejected() {
    let (mut env, m) = Env::with_market();
    env.create_market("META", DATE, 70_000).unwrap();
    let m70 = market_pda("META", DATE, 70_000);
    let bob = env.user(100 * USDC);
    env.warp(OPEN);
    env.mint_pair(&bob, &m, 2).unwrap();
    assert_err(env.merge_pair(&bob, &m, 0), MeridianError::ZeroQuantity);
    // Substituting another market's vault or mint is rejected.
    let mut ix = env.ix_mint_merge(&bob.pubkey(), &m, 1, false);
    let other_vault = env.market(&m70).vault;
    for a in ix.accounts.iter_mut() {
        if a.pubkey == env.market(&m).vault {
            a.pubkey = other_vault;
        }
    }
    assert_err(env.send(&[ix], &[&bob]), MeridianError::AccountMismatch);
}
