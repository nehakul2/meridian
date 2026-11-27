//! MER-12 · create_strike_market and add_strike.
//! Matrix: MKT-01, MKT-02, MKT-04, MKT-07, MKT-08, STK-08.
mod common;

use common::*;
use meridian::{
    constants::*,
    errors::MeridianError,
    events::MarketCreated,
    state::{MarketStatus, OrderBook, Outcome, TickerDay, TickerDayStatus},
};
use solana_sdk::{program_option::COption, signature::Signer};

#[test]
fn mkt_01_create_strike_market_creates_mints_vault_and_book() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let meta = env.create_market("META", DATE, STRIKE_680).unwrap();
    let mkey = market_pda("META", DATE, STRIKE_680);
    let m = env.market(&mkey);
    assert_eq!(m.status, MarketStatus::Trading);
    assert_eq!(m.outcome, Outcome::None);
    assert_eq!(
        (m.pairs_outstanding, m.collateral_accounted, m.total_minted),
        (0, 0, 0)
    );
    assert_eq!(m.strike_cents, STRIKE_680);
    assert_eq!(m.ticker_day, ticker_day_pda("META", DATE));
    assert_eq!(m.yes_mint, seeded(YES_MINT_SEED, &mkey));
    assert_eq!(m.no_mint, seeded(NO_MINT_SEED, &mkey));
    assert_eq!(m.vault, seeded(VAULT_SEED, &mkey));
    assert_eq!(m.book, seeded(BOOK_SEED, &mkey));
    for mint in [m.yes_mint, m.no_mint] {
        let info = env.mint_info(&mint);
        assert_eq!(info.decimals, 0);
        assert_eq!(info.mint_authority, COption::Some(mkey));
        assert_eq!(info.freeze_authority, COption::None);
        assert_eq!(info.supply, 0);
    }
    let vault = spl_token_account(&env, &m.vault);
    assert_eq!(vault.mint, env.usdc_mint);
    assert_eq!(vault.owner, mkey);
    let view = env.book(&mkey);
    let book: &OrderBook = view.get();
    assert_eq!(book.market, mkey);
    assert_eq!(book.next_order_id, 1);
    assert_eq!(book.base_vault, seeded(BASE_VAULT_SEED, &mkey));
    assert_eq!(book.quote_vault, seeded(QUOTE_VAULT_SEED, &mkey));
    assert_eq!(book.order_count, 0);
    let td: TickerDay = env.fetch(&ticker_day_pda("META", DATE));
    assert_eq!(td.strike_count, 1);

    let ev = events::<MarketCreated>(&meta);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].market, mkey);
    assert_eq!(ev[0].seq, 1);
    assert_eq!(ev[0].strike_cents, STRIKE_680);
    assert_eq!(ev[0].created_by, env.creator.pubkey());
    assert_eq!(m.seq, 1);
}

fn spl_token_account(env: &Env, addr: &solana_sdk::pubkey::Pubkey) -> spl_token::state::Account {
    use solana_sdk::program_pack::Pack;
    spl_token::state::Account::unpack(&env.svm.get_account(addr).unwrap().data).unwrap()
}

#[test]
fn mkt_02_creation_is_idempotent() {
    let (mut env, mkey) = Env::with_market();
    let before = env.svm.get_account(&mkey).unwrap();
    let meta = env.create_market("META", DATE, STRIKE_680).unwrap();
    assert!(
        events::<MarketCreated>(&meta).is_empty(),
        "no second MarketCreated"
    );
    // The admin path on the same strike is also a no-op.
    env.add_strike("META", DATE, STRIKE_680).unwrap();
    assert_eq!(env.svm.get_account(&mkey).unwrap().data, before.data);
    let td: TickerDay = env.fetch(&ticker_day_pda("META", DATE));
    assert_eq!(td.strike_count, 1);
}

#[test]
fn mkt_04_market_cannot_be_created_after_close_time() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    env.warp(CLOSE);
    assert_err(
        env.create_market("META", DATE, 69_000),
        MeridianError::MarketClosed,
    );
    env.warp(CLOSE + 1);
    assert_err(
        env.add_strike("META", DATE, 69_000),
        MeridianError::MarketClosed,
    );
    assert!(!env.exists(&market_pda("META", DATE, 69_000)));
}

#[test]
fn mkt_creation_rejected_once_close_recorded() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    // record_close lands in MER-31; simulate a recorded ticker-day.
    env.force_ticker_day(&ticker_day_pda("META", DATE), |t| {
        t.status = TickerDayStatus::Provisional
    });
    assert_err(
        env.create_market("META", DATE, 69_000),
        MeridianError::TickerDayNotOpen,
    );
}

#[test]
fn mkt_rejects_zero_strike_and_missing_ticker_day() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    assert_err(
        env.create_market("META", DATE, 0),
        MeridianError::InvalidStrike,
    );
    assert_fails(env.create_market("AAPL", DATE, 23_000));
}

#[test]
fn mkt_07_add_strike_by_admin_intraday() {
    let (mut env, _) = Env::with_market();
    env.warp(OPEN + 5_400); // 11:00 ET
    env.add_strike("META", DATE, 69_000).unwrap();
    let m69 = market_pda("META", DATE, 69_000);
    let m = env.market(&m69);
    assert_eq!(m.status, MarketStatus::Trading);
    assert_eq!(
        m.ticker_day,
        ticker_day_pda("META", DATE),
        "settles against the same TickerDay"
    );
    let bob = env.user(10 * USDC);
    env.mint_pair(&bob, &m69, 2).unwrap();
    assert_eq!(env.balances(&bob.pubkey(), &m69), (8 * USDC, 2, 2));
    let td: TickerDay = env.fetch(&ticker_day_pda("META", DATE));
    assert_eq!(td.strike_count, 2);
}

#[test]
fn mkt_08_no_adjust_strike_instruction_exists() {
    // Inspect the committed IDL: strike_cents is an argument only of the two creation
    // paths (both idempotent no-ops on an existing market), and nothing is named "adjust".
    let idl: serde_json::Value =
        serde_json::from_str(include_str!("../idl/meridian.json")).unwrap();
    let ixs = idl["instructions"].as_array().unwrap();
    let mut with_strike: Vec<&str> = vec![];
    for ix in ixs {
        let name = ix["name"].as_str().unwrap();
        assert!(!name.contains("adjust"), "found {name}");
        if ix["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"].as_str().unwrap().contains("strike"))
        {
            with_strike.push(name);
        }
    }
    with_strike.sort();
    assert_eq!(with_strike, ["add_strike", "create_strike_market"]);
    // In the source, strike_cents is assigned only inside Market::set_inner at creation.
    let writes: Vec<&str> = include_str!("../src/instructions/market.rs")
        .lines()
        .chain(include_str!("../src/instructions/mint_merge.rs").lines())
        .chain(include_str!("../src/instructions/config.rs").lines())
        .filter(|l| l.contains("strike_cents =") || l.contains(".strike_cents="))
        .collect();
    assert!(
        writes.is_empty(),
        "strike_cents assigned outside set_inner: {:?}",
        writes
    );
}

#[test]
fn stk_08_strike_stored_as_u64_cents_with_unique_pdas() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let strikes = [
        62_000u64, 64_000, 66_000, 68_000, 70_000, 72_000, 74_000, 68_050,
    ];
    for s in strikes {
        env.create_market("META", DATE, s).unwrap();
    }
    let mut keys = std::collections::HashSet::new();
    for s in strikes {
        let k = market_pda("META", DATE, s);
        assert!(keys.insert(k));
        assert_eq!(env.market(&k).strike_cents, s);
    }
    let td: TickerDay = env.fetch(&ticker_day_pda("META", DATE));
    assert_eq!(td.strike_count, strikes.len() as u32);
}

#[test]
fn mkt_wrong_signer_per_instruction_rejected() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let eve = env.user(0);
    assert_err(
        env.create_market_as(&eve, "META", DATE, STRIKE_680, false),
        MeridianError::Unauthorized,
    );
    assert_err(
        env.create_market_as(&eve, "META", DATE, STRIKE_680, true),
        MeridianError::Unauthorized,
    );
}

#[test]
fn mkt_rejects_non_canonical_ticker_day() {
    // A market must hang off the canonical ticker-day PDA for its (ticker, date).
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    env.create_ticker_day("AAPL", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    // AAPL ticker-day with a META-seeded market address: seeds mismatch, rejected.
    let creator = env.creator.insecure_clone();
    let ix = env.ix_create_market(
        &creator.pubkey(),
        ticker_day_pda("AAPL", DATE),
        market_pda("META", DATE, STRIKE_680),
        STRIKE_680,
        false,
    );
    let payer = env.payer.insecure_clone();
    assert_fails(env.send(&[ix], &[&payer, &creator]));
}
