//! Shared LiteSVM fixtures for program tests (test_case_matrix.md "Shared fixtures").
#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey, AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use litesvm::{types::TransactionMetadata, LiteSVM};
use meridian::{
    constants::*,
    instructions::{ConfigUpdate, InitializeConfigArgs, TickerArg},
    state::*,
};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    instruction::{Instruction, InstructionError},
    program_pack::Pack,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

pub const DATE: u32 = 20261125;
/// 2026-11-25 08:30 ET (mint opens, D26).
pub const MINT_OPEN: i64 = 1_795_613_400;
/// 2026-11-25 09:30 ET.
pub const OPEN: i64 = 1_795_617_000;
/// 2026-11-25 16:00 ET = 21:00 UTC.
pub const CLOSE: i64 = 1_795_640_400;
pub const STRIKE_680: u64 = 68_000;
pub const USDC: u64 = 1_000_000;

pub const MAG7: [&str; 7] = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

pub type TxResult = Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata>;

pub struct Env {
    pub svm: LiteSVM,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub creator: Keypair,
    pub settler: Keypair,
    pub payer: Keypair,
    pub usdc_mint: Pubkey,
    pub fee_vault: Pubkey,
    pub bond_vault: Pubkey,
}

pub fn feed_id(i: usize) -> [u8; 32] {
    [i as u8 + 1; 32]
}

pub fn mag7_args() -> Vec<TickerArg> {
    MAG7.iter()
        .enumerate()
        .map(|(i, s)| TickerArg {
            symbol: s.to_string(),
            feed_id: feed_id(i),
        })
        .collect()
}

pub fn program_so() -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/meridian.so"
    );
    std::fs::read(path).expect("build the program first: cargo build-sbf (or `make build`)")
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &meridian::ID).0
}
pub fn ticker_day_pda(ticker: &str, date: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[TICKER_DAY_SEED, ticker.as_bytes(), &date.to_le_bytes()],
        &meridian::ID,
    )
    .0
}
pub fn market_pda(ticker: &str, date: u32, strike: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            MARKET_SEED,
            ticker.as_bytes(),
            &date.to_le_bytes(),
            &strike.to_le_bytes(),
        ],
        &meridian::ID,
    )
    .0
}
pub fn seeded(seed: &[u8], market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[seed, market.as_ref()], &meridian::ID).0
}
pub fn bond_authority() -> Pubkey {
    Pubkey::find_program_address(&[BOND_AUTHORITY_SEED], &meridian::ID).0
}
pub fn dispute_pda(td: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[DISPUTE_SEED, td.as_ref()], &meridian::ID).0
}
pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &meridian::ID).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    spl_associated_token_account::get_associated_token_address(owner, mint)
}

/// Asserts a failed tx carries the given Meridian error code.
pub fn assert_err(res: TxResult, e: meridian::errors::MeridianError) {
    let want = anchor_lang::error::ERROR_CODE_OFFSET + e as u32;
    match res {
        Ok(_) => panic!("expected {:?}, tx succeeded", e),
        Err(f) => match f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) if c == want => {}
            other => panic!(
                "expected {:?} ({}), got {:?}\n{}",
                e,
                want,
                other,
                f.meta.pretty_logs()
            ),
        },
    }
}

pub fn assert_fails(res: TxResult) {
    assert!(res.is_err(), "expected failure, tx succeeded");
}

/// Decodes `emit_cpi!` events of type T from a transaction's inner instructions.
pub fn events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    let mut out = vec![];
    for ixs in &meta.inner_instructions {
        for ix in ixs {
            let data = &ix.instruction.data;
            let tag = anchor_lang::event::EVENT_IX_TAG_LE;
            if data.len() >= 16 && &data[..8] == tag && &data[8..16] == T::DISCRIMINATOR {
                out.push(T::deserialize(&mut &data[16..]).unwrap());
            }
        }
    }
    out
}

impl Env {
    /// Fresh SVM with the program deployed under the upgradeable loader (deployer = upgrade authority)
    /// and a 6-decimal USDC mint. Config not yet initialised.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        let deployer = Keypair::new();
        deploy_upgradeable(&mut svm, &program_so(), &deployer.pubkey());
        let env = Self {
            svm,
            deployer,
            admin: Keypair::new(),
            creator: Keypair::new(),
            settler: Keypair::new(),
            payer: Keypair::new(),
            usdc_mint: Pubkey::new_unique(),
            fee_vault: Pubkey::new_unique(),
            bond_vault: Pubkey::new_unique(),
        };
        let mut env = env;
        for k in [
            &env.deployer,
            &env.admin,
            &env.creator,
            &env.settler,
            &env.payer,
        ] {
            env.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let usdc = env.usdc_mint;
        env.put_mint(usdc, 6, Some(Pubkey::new_unique()));
        let (fv, admin) = (env.fee_vault, env.admin.pubkey());
        env.put_token_account(fv, usdc, admin, 0);
        // The bond vault is owned by the bond authority PDA (MER-37).
        let bv = env.bond_vault;
        env.put_token_account(bv, usdc, bond_authority(), 0);
        env.warp(MINT_OPEN - 3_600);
        env
    }

    /// Shared fixture: Config initialised with MAG7 and defaults.
    pub fn new() -> Self {
        let mut env = Self::bare();
        let args = env.init_args();
        env.initialize_config(&env.deployer.insecure_clone(), args)
            .unwrap();
        env
    }

    /// Shared fixture plus META 2026-11-25 ticker-day and market M680.
    pub fn with_market() -> (Self, Pubkey) {
        let mut env = Self::new();
        env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
            .unwrap();
        env.create_market("META", DATE, STRIKE_680).unwrap();
        (env, market_pda("META", DATE, STRIKE_680))
    }

    /// Cheap copy of the whole environment (LiteSVM state is cloned), for property tests.
    pub fn fork(&self) -> Self {
        Self {
            svm: self.svm.clone(),
            deployer: self.deployer.insecure_clone(),
            admin: self.admin.insecure_clone(),
            creator: self.creator.insecure_clone(),
            settler: self.settler.insecure_clone(),
            payer: self.payer.insecure_clone(),
            usdc_mint: self.usdc_mint,
            fee_vault: self.fee_vault,
            bond_vault: self.bond_vault,
        }
    }

    pub fn init_args(&self) -> InitializeConfigArgs {
        InitializeConfigArgs {
            admin: self.admin.pubkey(),
            market_creator: self.creator.pubkey(),
            settler: self.settler.pubkey(),
            fee_vault: self.fee_vault,
            bond_vault: self.bond_vault,
            tickers: mag7_args(),
        }
    }

    pub fn warp(&mut self, unix: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&signers[0].pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }

    pub fn user(&mut self, usdc: u64) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let mint = self.usdc_mint;
        self.put_token_account(ata(&kp.pubkey(), &mint), mint, kp.pubkey(), usdc);
        kp
    }

    pub fn put_mint(&mut self, addr: Pubkey, decimals: u8, authority: Option<Pubkey>) {
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: authority.into(),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 1_000_000_000,
                    data,
                    owner: spl_token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn put_token_account(&mut self, addr: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: None.into(),
            state: spl_token::state::AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 1_000_000_000,
                    data,
                    owner: spl_token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn token_balance(&self, addr: &Pubkey) -> u64 {
        match self.svm.get_account(addr) {
            Some(a) if !a.data.is_empty() => {
                spl_token::state::Account::unpack(&a.data).unwrap().amount
            }
            _ => 0,
        }
    }

    pub fn mint_info(&self, addr: &Pubkey) -> spl_token::state::Mint {
        spl_token::state::Mint::unpack(&self.svm.get_account(addr).unwrap().data).unwrap()
    }

    pub fn fetch<T: AccountDeserialize>(&self, addr: &Pubkey) -> T {
        let acc = self
            .svm
            .get_account(addr)
            .unwrap_or_else(|| panic!("account {} missing", addr));
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    pub fn exists(&self, addr: &Pubkey) -> bool {
        self.svm
            .get_account(addr)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn config(&self) -> Config {
        self.fetch(&config_pda())
    }
    pub fn market(&self, m: &Pubkey) -> Market {
        self.fetch(m)
    }

    // ---- instruction builders ----

    pub fn ix_initialize_config(
        &self,
        deployer: &Pubkey,
        args: InitializeConfigArgs,
    ) -> Instruction {
        let program_data =
            Pubkey::find_program_address(&[meridian::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::InitializeConfig {
                deployer: *deployer,
                config: config_pda(),
                usdc_mint: self.usdc_mint,
                program: meridian::ID,
                program_data,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::InitializeConfig { args }.data(),
        }
    }

    pub fn initialize_config(
        &mut self,
        deployer: &Keypair,
        args: InitializeConfigArgs,
    ) -> TxResult {
        let ix = self.ix_initialize_config(&deployer.pubkey(), args);
        self.send(&[ix], &[deployer])
    }

    pub fn update_config(&mut self, signer: &Keypair, update: ConfigUpdate) -> TxResult {
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::UpdateConfig {
                admin: signer.pubkey(),
                config: config_pda(),
            }
            .to_account_metas(None),
            data: meridian::instruction::UpdateConfig { update }.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn ix_set_paused(&self, signer: &Pubkey, paused: bool) -> Instruction {
        let accounts = meridian::accounts::SetPaused {
            admin: *signer,
            config: config_pda(),
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        let data = if paused {
            meridian::instruction::Pause {}.data()
        } else {
            meridian::instruction::Unpause {}.data()
        };
        Instruction {
            program_id: meridian::ID,
            accounts,
            data,
        }
    }

    pub fn set_paused(&mut self, signer: &Keypair, paused: bool) -> TxResult {
        let ix = self.ix_set_paused(&signer.pubkey(), paused);
        self.send(&[ix], &[signer])
    }

    pub fn create_ticker_day_as(
        &mut self,
        signer: &Keypair,
        ticker: &str,
        date: u32,
        mint_open: i64,
        open: i64,
        close: i64,
    ) -> TxResult {
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::CreateTickerDay {
                payer: self.payer.pubkey(),
                creator: signer.pubkey(),
                config: config_pda(),
                ticker_day: ticker_day_pda(ticker, date),
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::CreateTickerDay {
                ticker: ticker.to_string(),
                date,
                mint_open_time: mint_open,
                open_time: open,
                close_time: close,
            }
            .data(),
        };
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &[&payer, signer])
    }

    pub fn create_ticker_day(
        &mut self,
        ticker: &str,
        date: u32,
        mint_open: i64,
        open: i64,
        close: i64,
    ) -> TxResult {
        let creator = self.creator.insecure_clone();
        self.create_ticker_day_as(&creator, ticker, date, mint_open, open, close)
    }

    pub fn ix_create_market(
        &self,
        authority: &Pubkey,
        ticker_day: Pubkey,
        market: Pubkey,
        strike: u64,
        admin_path: bool,
    ) -> Instruction {
        let accounts = meridian::accounts::CreateMarket {
            payer: self.payer.pubkey(),
            authority: *authority,
            config: config_pda(),
            ticker_day,
            market,
            yes_mint: seeded(YES_MINT_SEED, &market),
            no_mint: seeded(NO_MINT_SEED, &market),
            vault: seeded(VAULT_SEED, &market),
            book: seeded(BOOK_SEED, &market),
            base_vault: seeded(BASE_VAULT_SEED, &market),
            quote_vault: seeded(QUOTE_VAULT_SEED, &market),
            usdc_mint: self.usdc_mint,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        let data = if admin_path {
            meridian::instruction::AddStrike {
                strike_cents: strike,
            }
            .data()
        } else {
            meridian::instruction::CreateStrikeMarket {
                strike_cents: strike,
            }
            .data()
        };
        Instruction {
            program_id: meridian::ID,
            accounts,
            data,
        }
    }

    pub fn create_market_as(
        &mut self,
        signer: &Keypair,
        ticker: &str,
        date: u32,
        strike: u64,
        admin_path: bool,
    ) -> TxResult {
        let market = market_pda(ticker, date, strike);
        let ix = self.ix_create_market(
            &signer.pubkey(),
            ticker_day_pda(ticker, date),
            market,
            strike,
            admin_path,
        );
        // What the morning job sends: create, then grow the book to full size (MER-20).
        let mut ixs = vec![ix];
        ixs.extend(self.ix_grow_book_all(&market));
        let payer = self.payer.insecure_clone();
        self.send(&ixs, &[&payer, signer])
    }

    pub fn create_market(&mut self, ticker: &str, date: u32, strike: u64) -> TxResult {
        let creator = self.creator.insecure_clone();
        self.create_market_as(&creator, ticker, date, strike, false)
    }

    pub fn add_strike(&mut self, ticker: &str, date: u32, strike: u64) -> TxResult {
        let admin = self.admin.insecure_clone();
        self.create_market_as(&admin, ticker, date, strike, true)
    }

    pub fn ix_grow_book(&self, market: &Pubkey) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::GrowBook {
                payer: self.payer.pubkey(),
                market: *market,
                book: seeded(BOOK_SEED, market),
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::GrowBook {}.data(),
        }
    }

    /// Enough grow_book instructions to take a fresh book to full size.
    pub fn ix_grow_book_all(&self, market: &Pubkey) -> Vec<Instruction> {
        let steps = (OrderBook::LEN - BOOK_GROWTH_STEP).div_ceil(BOOK_GROWTH_STEP);
        (0..steps).map(|_| self.ix_grow_book(market)).collect()
    }

    pub fn ix_mint_merge(
        &self,
        user: &Pubkey,
        market: &Pubkey,
        n: u64,
        merge: bool,
    ) -> Instruction {
        let m = self.market(market);
        let accounts = meridian::accounts::MintMerge {
            user: *user,
            config: config_pda(),
            ticker_day: m.ticker_day,
            market: *market,
            yes_mint: m.yes_mint,
            no_mint: m.no_mint,
            vault: m.vault,
            user_usdc: ata(user, &self.usdc_mint),
            user_yes: ata(user, &m.yes_mint),
            user_no: ata(user, &m.no_mint),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        let data = if merge {
            meridian::instruction::MergePair { n }.data()
        } else {
            meridian::instruction::MintPair { n }.data()
        };
        Instruction {
            program_id: meridian::ID,
            accounts,
            data,
        }
    }

    pub fn mint_pair(&mut self, user: &Keypair, market: &Pubkey, n: u64) -> TxResult {
        let ix = self.ix_mint_merge(&user.pubkey(), market, n, false);
        self.send(&[ix], &[user])
    }

    pub fn merge_pair(&mut self, user: &Keypair, market: &Pubkey, n: u64) -> TxResult {
        let ix = self.ix_mint_merge(&user.pubkey(), market, n, true);
        self.send(&[ix], &[user])
    }

    /// (usdc, yes, no) balances of a user in a market.
    pub fn balances(&self, user: &Pubkey, market: &Pubkey) -> (u64, u64, u64) {
        let m = self.market(market);
        (
            self.token_balance(&ata(user, &self.usdc_mint)),
            self.token_balance(&ata(user, &m.yes_mint)),
            self.token_balance(&ata(user, &m.no_mint)),
        )
    }

    /// Writes market fields directly. Only for tests of states later phases reach
    /// (for example SETTLED before settle_market exists).
    pub fn force_market(&mut self, market: &Pubkey, f: impl FnOnce(&mut Market)) {
        let mut acc = self.svm.get_account(market).unwrap();
        let mut m: Market = Market::try_deserialize(&mut acc.data.as_slice()).unwrap();
        f(&mut m);
        let mut data = Vec::with_capacity(acc.data.len());
        anchor_lang::AccountSerialize::try_serialize(&m, &mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        self.svm.set_account(*market, acc).unwrap();
    }

    pub fn force_ticker_day(&mut self, td: &Pubkey, f: impl FnOnce(&mut TickerDay)) {
        let mut acc = self.svm.get_account(td).unwrap();
        let mut t: TickerDay = TickerDay::try_deserialize(&mut acc.data.as_slice()).unwrap();
        f(&mut t);
        let mut data = Vec::with_capacity(acc.data.len());
        anchor_lang::AccountSerialize::try_serialize(&t, &mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        self.svm.set_account(*td, acc).unwrap();
    }
}

// ---- order book (Phase 2) ----

pub use meridian::events::{Side, TimeInForce};

pub fn ledger_pda(market: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[LEDGER_SEED, market.as_ref(), owner.as_ref()],
        &meridian::ID,
    )
    .0
}

/// An aligned copy of the zero-copy book.
pub struct BookView(Vec<u64>);
impl BookView {
    pub fn get(&self) -> &OrderBook {
        bytemuck::from_bytes(
            &bytemuck::cast_slice::<u64, u8>(&self.0)[..std::mem::size_of::<OrderBook>()],
        )
    }
    /// (owner, order_id, qty, tag) at a level, oldest first.
    pub fn level(&self, side: Side, price: u8) -> Vec<(Pubkey, u64, u64, u8)> {
        let s = if side == Side::Bid {
            SIDE_BID
        } else {
            SIDE_ASK
        };
        let l = self.get().level(s, price);
        l.orders[..l.len as usize]
            .iter()
            .map(|o| (o.owner, o.order_id, o.qty, o.tag))
            .collect()
    }
}

pub enum TradeIx {
    Place {
        side: Side,
        price: u8,
        qty: u64,
        tif: TimeInForce,
    },
    BuyNoMarket {
        qty: u64,
        min_yes: u8,
    },
    BuyNoLimit {
        qty: u64,
        yes_price: u8,
    },
    SellNo {
        qty: u64,
        max_yes: u8,
    },
}

impl Env {
    pub fn book(&self, market: &Pubkey) -> BookView {
        let m = self.market(market);
        let acc = self.svm.get_account(&m.book).unwrap();
        assert_eq!(acc.data.len(), OrderBook::LEN, "book not fully grown");
        let mut buf = vec![0u64; (acc.data.len() - 8).div_ceil(8)];
        bytemuck::cast_slice_mut::<u64, u8>(&mut buf)[..acc.data.len() - 8]
            .copy_from_slice(&acc.data[8..]);
        BookView(buf)
    }

    pub fn ledger(&self, market: &Pubkey, owner: &Pubkey) -> UserLedger {
        self.fetch(&ledger_pda(market, owner))
    }

    /// Ledgers of every resting owner on the side a taker of `taker_side` would hit.
    pub fn makers_for(&self, market: &Pubkey, taker: &Pubkey, taker_side: usize) -> Vec<Pubkey> {
        let view = self.book(market);
        let b = view.get();
        let maker_side = 1 - taker_side;
        let mut out: Vec<Pubkey> = vec![];
        for p in MIN_PRICE..=MAX_PRICE {
            let l = b.level(maker_side, p);
            for o in &l.orders[..l.len as usize] {
                let k = ledger_pda(market, &o.owner);
                if o.owner != *taker && !out.contains(&k) {
                    out.push(k);
                }
            }
        }
        out
    }

    pub fn ix_trade(
        &self,
        user: &Pubkey,
        market: &Pubkey,
        t: &TradeIx,
        makers: &[Pubkey],
    ) -> Instruction {
        let m = self.market(market);
        let mut accounts = meridian::accounts::Trade {
            user: *user,
            config: config_pda(),
            ticker_day: m.ticker_day,
            market: *market,
            book: m.book,
            base_vault: seeded(BASE_VAULT_SEED, market),
            quote_vault: seeded(QUOTE_VAULT_SEED, market),
            vault: m.vault,
            yes_mint: m.yes_mint,
            no_mint: m.no_mint,
            ledger: ledger_pda(market, user),
            user_usdc: ata(user, &self.usdc_mint),
            user_yes: ata(user, &m.yes_mint),
            user_no: ata(user, &m.no_mint),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        for k in makers {
            accounts.push(solana_sdk::instruction::AccountMeta::new(*k, false));
        }
        let data = match *t {
            TradeIx::Place {
                side,
                price,
                qty,
                tif,
            } => meridian::instruction::PlaceOrder {
                side,
                price,
                qty,
                tif,
                client_id: 7,
            }
            .data(),
            TradeIx::BuyNoMarket { qty, min_yes } => meridian::instruction::BuyNoMarket {
                qty,
                min_yes_price: min_yes,
            }
            .data(),
            TradeIx::BuyNoLimit { qty, yes_price } => {
                meridian::instruction::BuyNoLimit { qty, yes_price }.data()
            }
            TradeIx::SellNo { qty, max_yes } => meridian::instruction::SellNo {
                qty,
                max_yes_price: max_yes,
            }
            .data(),
        };
        Instruction {
            program_id: meridian::ID,
            accounts,
            data,
        }
    }

    /// Builds a trade with every maker ledger it could need, read from the current book.
    pub fn ix_trade_auto(&self, user: &Pubkey, market: &Pubkey, t: &TradeIx) -> Instruction {
        let taker_side = match t {
            TradeIx::Place {
                side: Side::Bid, ..
            }
            | TradeIx::SellNo { .. } => SIDE_BID,
            _ => SIDE_ASK,
        };
        let makers = self.makers_for(market, user, taker_side);
        self.ix_trade(user, market, t, &makers)
    }

    pub fn trade(&mut self, user: &Keypair, market: &Pubkey, t: TradeIx) -> TxResult {
        let ix = self.ix_trade_auto(&user.pubkey(), market, &t);
        self.send(&[ix], &[user])
    }

    pub fn place(
        &mut self,
        user: &Keypair,
        market: &Pubkey,
        side: Side,
        price: u8,
        qty: u64,
        tif: TimeInForce,
    ) -> TxResult {
        self.trade(
            user,
            market,
            TradeIx::Place {
                side,
                price,
                qty,
                tif,
            },
        )
    }
    pub fn bid(
        &mut self,
        user: &Keypair,
        market: &Pubkey,
        price: u8,
        qty: u64,
        tif: TimeInForce,
    ) -> TxResult {
        self.place(user, market, Side::Bid, price, qty, tif)
    }
    pub fn ask(
        &mut self,
        user: &Keypair,
        market: &Pubkey,
        price: u8,
        qty: u64,
        tif: TimeInForce,
    ) -> TxResult {
        self.place(user, market, Side::Ask, price, qty, tif)
    }

    pub fn ix_cancel(&self, owner: &Pubkey, market: &Pubkey, order_id: Option<u64>) -> Instruction {
        let m = self.market(market);
        let accounts = meridian::accounts::CancelOrders {
            owner: *owner,
            config: config_pda(),
            market: *market,
            book: m.book,
            ledger: ledger_pda(market, owner),
            base_vault: seeded(BASE_VAULT_SEED, market),
            quote_vault: seeded(QUOTE_VAULT_SEED, market),
            vault: m.vault,
            yes_mint: m.yes_mint,
            no_mint: m.no_mint,
            user_usdc: ata(owner, &self.usdc_mint),
            user_no: ata(owner, &m.no_mint),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        let data = match order_id {
            Some(order_id) => meridian::instruction::CancelOrder { order_id }.data(),
            None => meridian::instruction::CancelAll {}.data(),
        };
        Instruction {
            program_id: meridian::ID,
            accounts,
            data,
        }
    }

    pub fn cancel(&mut self, owner: &Keypair, market: &Pubkey, order_id: u64) -> TxResult {
        let ix = self.ix_cancel(&owner.pubkey(), market, Some(order_id));
        self.send(&[ix], &[owner])
    }

    pub fn cancel_all(&mut self, owner: &Keypair, market: &Pubkey) -> TxResult {
        let ix = self.ix_cancel(&owner.pubkey(), market, None);
        self.send(&[ix], &[owner])
    }

    pub fn ix_withdraw(&self, owner: &Pubkey, market: &Pubkey, ledger: Pubkey) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Withdraw {
                owner: *owner,
                config: config_pda(),
                market: *market,
                book: m.book,
                ledger,
                base_vault: seeded(BASE_VAULT_SEED, market),
                quote_vault: seeded(QUOTE_VAULT_SEED, market),
                yes_mint: m.yes_mint,
                user_usdc: ata(owner, &self.usdc_mint),
                user_yes: ata(owner, &m.yes_mint),
                token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: solana_sdk::system_program::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::Withdraw {}.data(),
        }
    }

    pub fn sweep_fees(&mut self, market: &Pubkey) -> TxResult {
        let m = self.market(market);
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SweepFees {
                config: config_pda(),
                market: *market,
                book: m.book,
                quote_vault: seeded(QUOTE_VAULT_SEED, market),
                fee_vault: self.config().fee_vault,
                token_program: spl_token::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::SweepFees {}.data(),
        };
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &[&payer])
    }

    pub fn withdraw(&mut self, owner: &Keypair, market: &Pubkey) -> TxResult {
        let ix = self.ix_withdraw(&owner.pubkey(), market, ledger_pda(market, &owner.pubkey()));
        self.send(&[ix], &[owner])
    }

    /// A user holding `yes` Yes (minted as pairs, No kept) with `usdc` left over.
    pub fn user_with_yes(&mut self, market: &Pubkey, usdc: u64, yes: u64) -> Keypair {
        let u = self.user(usdc + yes * USDC);
        if yes > 0 {
            self.mint_pair(&u, market, yes).unwrap();
        }
        u
    }

    /// Book escrow invariant (INV-05) plus "book totals == sum of the given ledgers".
    pub fn assert_book_escrow(&self, market: &Pubkey, owners: &[Pubkey]) {
        let view = self.book(market);
        let b = view.get();
        let base = self.token_balance(&seeded(BASE_VAULT_SEED, market));
        let quote = self.token_balance(&seeded(QUOTE_VAULT_SEED, market));
        assert!(
            meridian::invariants::check_book_escrow(base, quote, b),
            "INV-05 broken"
        );
        let mut sums = (0u64, 0u64, 0u64, 0u64);
        for o in owners {
            if !self.exists(&ledger_pda(market, o)) {
                continue;
            }
            let l = self.ledger(market, o);
            sums.0 += l.locked_usdc;
            sums.1 += l.free_usdc;
            sums.2 += l.locked_yes;
            sums.3 += l.free_yes;
        }
        assert_eq!(
            sums,
            (
                b.total_locked_usdc,
                b.total_free_usdc,
                b.total_locked_yes,
                b.total_free_yes
            ),
            "book totals differ from the sum of ledgers"
        );
    }
}

/// Installs the program under the upgradeable loader with the given upgrade authority,
/// so `initialize_config` can check the ProgramData upgrade authority.
pub fn deploy_upgradeable(svm: &mut LiteSVM, elf: &[u8], authority: &Pubkey) {
    let program_data =
        Pubkey::find_program_address(&[meridian::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
    let mut pd = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(*authority),
    })
    .unwrap();
    pd.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
    pd.extend_from_slice(elf);
    let lamports = svm.minimum_balance_for_rent_exemption(pd.len());
    svm.set_account(
        program_data,
        Account {
            lamports,
            data: pd,
            owner: bpf_loader_upgradeable::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let prog = bincode::serialize(&UpgradeableLoaderState::Program {
        programdata_address: program_data,
    })
    .unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(prog.len());
    svm.set_account(
        meridian::ID,
        Account {
            lamports,
            data: prog,
            owner: bpf_loader_upgradeable::ID,
            executable: true,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

// ---- settlement (Phase 3) ----

pub use meridian::instructions::{OfficialClose, Resolution};

/// META's index in MAG7 (its feed id is `feed_id(META_IDX)`).
pub const META_IDX: usize = 5;
/// Pyth equity feeds use expo -5.
pub const EXPO: i32 = -5;
/// Dollars to a price at expo -5 (whole cents only).
pub const fn px(cents: i64) -> i64 {
    cents * 1_000
}

/// A Pyth `PriceUpdateV2` as the receiver would write it.
#[derive(Clone, Copy, Debug)]
pub struct Update {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    /// `None` = Full; `Some(n)` = Partial { num_signatures: n }.
    pub partial: Option<u8>,
    pub owner: Pubkey,
}

impl Update {
    /// META update at the close with the given price (expo -5) and confidence in bps.
    pub fn meta(price: i64, conf_bps: u64) -> Self {
        Self {
            feed_id: feed_id(META_IDX),
            price,
            conf: (price as u64) * conf_bps / 10_000,
            expo: EXPO,
            publish_time: CLOSE,
            partial: None,
            owner: PYTH_RECEIVER_ID,
        }
    }
    pub fn at(mut self, t: i64) -> Self {
        self.publish_time = t;
        self
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut d = vec![];
        d.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        d.extend_from_slice(&[7u8; 32]); // write_authority
        match self.partial {
            None => d.push(1),
            Some(n) => {
                d.push(0);
                d.push(n);
            }
        }
        d.extend_from_slice(&self.feed_id);
        d.extend_from_slice(&self.price.to_le_bytes());
        d.extend_from_slice(&self.conf.to_le_bytes());
        d.extend_from_slice(&self.expo.to_le_bytes());
        d.extend_from_slice(&self.publish_time.to_le_bytes());
        d.extend_from_slice(&(self.publish_time - 1).to_le_bytes()); // prev_publish_time
        d.extend_from_slice(&self.price.to_le_bytes()); // ema_price
        d.extend_from_slice(&self.conf.to_le_bytes()); // ema_conf
        d.extend_from_slice(&1u64.to_le_bytes()); // posted_slot
        d
    }
}

impl Env {
    /// Writes a price update account and returns its address.
    pub fn put_update(&mut self, u: &Update) -> Pubkey {
        let addr = Pubkey::new_unique();
        self.svm
            .set_account(
                addr,
                Account {
                    lamports: 1_000_000_000,
                    data: u.bytes(),
                    owner: u.owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        addr
    }

    pub fn ticker_day(&self, td: &Pubkey) -> TickerDay {
        self.fetch(td)
    }

    pub fn ix_record_close(
        &self,
        signer: &Pubkey,
        td: &Pubkey,
        update: &Pubkey,
        official: Option<OfficialClose>,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::RecordClose {
                settler: *signer,
                config: config_pda(),
                ticker_day: *td,
                price_update: *update,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::RecordClose { official }.data(),
        }
    }

    /// `signer` records META's close from update `u` with an attested official close.
    pub fn record_close_as(
        &mut self,
        signer: &Keypair,
        u: &Update,
        official: Option<i64>,
    ) -> TxResult {
        let addr = self.put_update(u);
        let td = ticker_day_pda("META", DATE);
        let official = official.map(|price| OfficialClose {
            price,
            expo: u.expo,
        });
        let ix = self.ix_record_close(&signer.pubkey(), &td, &addr, official);
        self.send(&[ix], &[signer])
    }

    /// Settler records META with official close = the update's price.
    pub fn record_close(&mut self, u: &Update) -> TxResult {
        let s = self.settler.insecure_clone();
        self.record_close_as(&s, u, Some(u.price))
    }

    pub fn ix_admin_settle(
        &self,
        signer: &Pubkey,
        td: &Pubkey,
        price: i64,
        expo: i32,
    ) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::AdminSettle {
                admin: *signer,
                config: config_pda(),
                ticker_day: *td,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::AdminSettle { price, expo }.data(),
        }
    }

    pub fn admin_settle_as(&mut self, signer: &Keypair, price: i64) -> TxResult {
        let ix = self.ix_admin_settle(&signer.pubkey(), &ticker_day_pda("META", DATE), price, EXPO);
        self.send(&[ix], &[signer])
    }

    pub fn ix_raise_dispute(&self, disputer: &Pubkey, td: &Pubkey, hash: [u8; 32]) -> Instruction {
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::RaiseDispute {
                disputer: *disputer,
                config: config_pda(),
                ticker_day: *td,
                dispute: dispute_pda(td),
                disputer_usdc: ata(disputer, &self.usdc_mint),
                bond_vault: self.config().bond_vault,
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::RaiseDispute {
                evidence_hash: hash,
            }
            .data(),
        }
    }

    pub fn raise_dispute(&mut self, disputer: &Keypair) -> TxResult {
        let ix =
            self.ix_raise_dispute(&disputer.pubkey(), &ticker_day_pda("META", DATE), [9u8; 32]);
        self.send(&[ix], &[disputer])
    }

    pub fn ix_resolve_dispute(&self, signer: &Pubkey, td: &Pubkey, r: Resolution) -> Instruction {
        let d: Dispute = self.fetch(&dispute_pda(td));
        let cfg = self.config();
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::ResolveDispute {
                admin: *signer,
                config: config_pda(),
                ticker_day: *td,
                dispute: dispute_pda(td),
                bond_vault: cfg.bond_vault,
                bond_authority: bond_authority(),
                fee_vault: cfg.fee_vault,
                disputer_usdc: ata(&d.disputer, &self.usdc_mint),
                token_program: spl_token::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::ResolveDispute { resolution: r }.data(),
        }
    }

    pub fn resolve_dispute_as(&mut self, signer: &Keypair, r: Resolution) -> TxResult {
        let ix = self.ix_resolve_dispute(&signer.pubkey(), &ticker_day_pda("META", DATE), r);
        self.send(&[ix], &[signer])
    }

    /// finalize_close; passes the dispute accounts when a dispute exists.
    pub fn ix_finalize_close(&self, td: &Pubkey) -> Instruction {
        let dp = dispute_pda(td);
        let cfg = self.config();
        let none = meridian::ID;
        let (dispute, bond_vault, bond_auth, disputer_usdc, tp) = if self.exists(&dp) {
            let d: Dispute = self.fetch(&dp);
            (
                dp,
                cfg.bond_vault,
                bond_authority(),
                ata(&d.disputer, &self.usdc_mint),
                spl_token::ID,
            )
        } else {
            (none, none, none, none, none)
        };
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::FinalizeClose {
                config: config_pda(),
                ticker_day: *td,
                dispute: Some(dispute),
                bond_vault: Some(bond_vault),
                bond_authority: Some(bond_auth),
                disputer_usdc: Some(disputer_usdc),
                token_program: Some(tp),
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::FinalizeClose {}.data(),
        }
    }

    pub fn finalize_close_as(&mut self, signer: &Keypair) -> TxResult {
        let ix = self.ix_finalize_close(&ticker_day_pda("META", DATE));
        self.send(&[ix], &[signer])
    }

    pub fn finalize_close(&mut self) -> TxResult {
        let p = self.payer.insecure_clone();
        self.finalize_close_as(&p)
    }

    /// Happy path to FINAL: warp to close + 5 min, record `price` (conf 1 bp, expo -5),
    /// warp past the dispute window and finalize.
    pub fn close_at(&mut self, price: i64) {
        self.close_with(Update::meta(price, 1));
    }

    pub fn close_with(&mut self, u: Update) {
        if self.now() < CLOSE + 300 {
            self.warp(CLOSE + 300);
        }
        self.record_close(&u).unwrap();
        let t = self.now() + self.config().dispute_window_s;
        self.warp(t);
        self.finalize_close().unwrap();
    }

    pub fn ix_settle_market(&self, market: &Pubkey) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::SettleMarket {
                ticker_day: m.ticker_day,
                market: *market,
                vault: m.vault,
                yes_mint: m.yes_mint,
                no_mint: m.no_mint,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::SettleMarket {}.data(),
        }
    }

    pub fn settle_as(&mut self, signer: &Keypair, market: &Pubkey) -> TxResult {
        let ix = self.ix_settle_market(market);
        self.send(&[ix], &[signer])
    }

    pub fn settle(&mut self, market: &Pubkey) -> TxResult {
        let p = self.payer.insecure_clone();
        self.settle_as(&p, market)
    }

    pub fn admin_settle_market_as(
        &mut self,
        signer: &Keypair,
        market: &Pubkey,
        outcome: Outcome,
    ) -> TxResult {
        let m = self.market(market);
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::AdminSettleMarket {
                admin: signer.pubkey(),
                config: config_pda(),
                ticker_day: m.ticker_day,
                market: *market,
                vault: m.vault,
                yes_mint: m.yes_mint,
                no_mint: m.no_mint,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::AdminSettleMarket { outcome }.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn void_market_as(&mut self, signer: &Keypair, market: &Pubkey) -> TxResult {
        let m = self.market(market);
        let ix = Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::VoidMarket {
                admin: signer.pubkey(),
                config: config_pda(),
                market: *market,
                vault: m.vault,
                yes_mint: m.yes_mint,
                no_mint: m.no_mint,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::VoidMarket {}.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn ix_redeem_with(
        &self,
        user: &Pubkey,
        market: &Pubkey,
        user_yes: Pubkey,
        user_no: Pubkey,
        yes_n: u64,
        no_n: u64,
    ) -> Instruction {
        let m = self.market(market);
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::Redeem {
                user: *user,
                config: config_pda(),
                market: *market,
                vault: m.vault,
                yes_mint: m.yes_mint,
                no_mint: m.no_mint,
                user_yes,
                user_no,
                user_usdc: ata(user, &self.usdc_mint),
                token_program: spl_token::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::Redeem { yes_n, no_n }.data(),
        }
    }

    pub fn ix_redeem(&self, user: &Pubkey, market: &Pubkey, yes_n: u64, no_n: u64) -> Instruction {
        let m = self.market(market);
        self.ix_redeem_with(
            user,
            market,
            ata(user, &m.yes_mint),
            ata(user, &m.no_mint),
            yes_n,
            no_n,
        )
    }

    /// Redeem; creates the user's Yes and No ATAs first if they are missing.
    pub fn redeem(&mut self, user: &Keypair, market: &Pubkey, yes_n: u64, no_n: u64) -> TxResult {
        let m = self.market(market);
        let mut ixs = vec![];
        for mint in [m.yes_mint, m.no_mint] {
            if !self.exists(&ata(&user.pubkey(), &mint)) {
                ixs.push(
                    spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                        &user.pubkey(),
                        &user.pubkey(),
                        &mint,
                        &spl_token::ID,
                    ),
                );
            }
        }
        ixs.push(self.ix_redeem(&user.pubkey(), market, yes_n, no_n));
        self.send(&ixs, &[user])
    }

    pub fn ix_prune(&self, market: &Pubkey, max: u16, remaining: &[Pubkey]) -> Instruction {
        let m = self.market(market);
        let mut accounts = meridian::accounts::PruneOrders {
            ticker_day: m.ticker_day,
            market: *market,
            book: m.book,
            base_vault: seeded(BASE_VAULT_SEED, market),
            quote_vault: seeded(QUOTE_VAULT_SEED, market),
            vault: m.vault,
            yes_mint: m.yes_mint,
            no_mint: m.no_mint,
            token_program: spl_token::ID,
            event_authority: event_authority(),
            program: meridian::ID,
        }
        .to_account_metas(None);
        for k in remaining {
            accounts.push(solana_sdk::instruction::AccountMeta::new(*k, false));
        }
        Instruction {
            program_id: meridian::ID,
            accounts,
            data: meridian::instruction::PruneOrders { max }.data(),
        }
    }

    /// Every resting owner's ledger, plus the No ATA of every BUY_NO owner, in book order.
    pub fn prune_accounts(&self, market: &Pubkey) -> Vec<Pubkey> {
        let m = self.market(market);
        let view = self.book(market);
        let b = view.get();
        let mut out: Vec<Pubkey> = vec![];
        for side in [SIDE_BID, SIDE_ASK] {
            for p in MIN_PRICE..=MAX_PRICE {
                let l = b.level(side, p);
                for o in &l.orders[..l.len as usize] {
                    let k = ledger_pda(market, &o.owner);
                    if !out.contains(&k) {
                        out.push(k);
                    }
                    let n = ata(&o.owner, &m.no_mint);
                    if o.tag == ORDER_TAG_BUY_NO && !out.contains(&n) {
                        out.push(n);
                    }
                }
            }
        }
        out
    }

    pub fn prune(&mut self, market: &Pubkey, max: u16) -> TxResult {
        let accs = self.prune_accounts(market);
        let ix = self.ix_prune(market, max, &accs);
        let p = self.payer.insecure_clone();
        self.send(&[budget(1_400_000), ix], &[&p])
    }

    pub fn ix_close_book(&self, market: &Pubkey) -> Instruction {
        let m = self.market(market);
        let cfg = self.config();
        Instruction {
            program_id: meridian::ID,
            accounts: meridian::accounts::CloseBook {
                config: config_pda(),
                market: *market,
                book: m.book,
                rent_receiver: cfg.market_creator,
                quote_vault: seeded(QUOTE_VAULT_SEED, market),
                fee_vault: cfg.fee_vault,
                token_program: spl_token::ID,
                event_authority: event_authority(),
                program: meridian::ID,
            }
            .to_account_metas(None),
            data: meridian::instruction::CloseBook {}.data(),
        }
    }

    pub fn close_book(&mut self, market: &Pubkey) -> TxResult {
        let ix = self.ix_close_book(market);
        let p = self.payer.insecure_clone();
        self.send(&[ix], &[&p])
    }

    /// Total USDC in every wallet, ledger-free balance excluded (those sit in vaults).
    pub fn usdc_of(&self, owner: &Pubkey) -> u64 {
        self.token_balance(&ata(owner, &self.usdc_mint))
    }
}

pub fn budget(units: u32) -> Instruction {
    solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(units)
}
