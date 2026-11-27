//! MER-10 · initialize_config, update_config and role separation.
//! Matrix: CFG-01, CFG-02, CFG-03, CFG-04, CFG-05, CFG-07, SEC-05.
mod common;

use common::*;
use meridian::{
    constants::*, errors::MeridianError, instructions::ConfigUpdate, state::CloseSourceMode,
};
use solana_sdk::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

#[test]
fn cfg_01_initialize_config_sets_fields_and_defaults() {
    let env = Env::new();
    let c = env.config();
    assert_eq!(c.admin, env.admin.pubkey());
    assert_eq!(c.market_creator, env.creator.pubkey());
    assert_eq!(c.settler, env.settler.pubkey());
    assert_eq!(c.usdc_mint, env.usdc_mint);
    assert_eq!(c.fee_vault, env.fee_vault);
    assert_eq!(c.bond_vault, env.bond_vault);
    assert!(!c.paused);
    // Defaults (MER-10 DoD, D4, D8, D27, D28).
    assert_eq!(c.override_delay_s, 1800);
    assert_eq!(c.settle_window_s, 5);
    assert_eq!(c.conf_bps_max, 10);
    assert_eq!(c.fee_bps, 0);
    assert_eq!(c.close_tolerance_bps, 20);
    assert_eq!(c.dispute_window_s, 1200);
    assert_eq!(c.dispute_bond, 100 * USDC);
    assert_eq!(c.dispute_resolution_s, 86_400);
    assert_eq!(c.close_source_mode, CloseSourceMode::AttestedChecked);
    // Ticker list round-trips with feed ids.
    for (i, s) in MAG7.iter().enumerate() {
        assert_eq!(c.tickers[i].symbol_str(), *s);
        assert_eq!(c.tickers[i].feed_id, feed_id(i));
    }
    let (_, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &meridian::ID);
    assert_eq!(c.bump, bump);
}

#[test]
fn cfg_02_config_cannot_be_initialised_twice() {
    let mut env = Env::new();
    let mut args = env.init_args();
    args.admin = Keypair::new().pubkey();
    let deployer = env.deployer.insecure_clone();
    assert_fails(env.initialize_config(&deployer, args));
    assert_eq!(env.config().admin, env.admin.pubkey());
}

#[test]
fn cfg_03_only_admin_can_update_config() {
    let mut env = Env::new();
    let eve = env.user(100 * USDC);
    let creator = env.creator.insecure_clone();
    let settler = env.settler.insecure_clone();
    let admin = env.admin.insecure_clone();
    let u = || ConfigUpdate {
        fee_bps: Some(500),
        ..Default::default()
    };
    for k in [&eve, &creator, &settler] {
        assert_err(env.update_config(k, u()), MeridianError::Unauthorized);
        assert_eq!(env.config().fee_bps, 0);
    }
    env.update_config(&admin, u()).unwrap();
    assert_eq!(env.config().fee_bps, 500);
}

#[test]
fn cfg_04_roles_are_separate_keys() {
    let mut env = Env::new();
    env.create_ticker_day("META", DATE, MINT_OPEN, OPEN, CLOSE)
        .unwrap();
    let creator = env.creator.insecure_clone();
    let settler = env.settler.insecure_clone();
    let admin = env.admin.insecure_clone();

    // Settler cannot create ticker-days or markets; creator and settler cannot add_strike.
    assert_err(
        env.create_ticker_day_as(&settler, "AAPL", DATE, MINT_OPEN, OPEN, CLOSE),
        MeridianError::Unauthorized,
    );
    assert_err(
        env.create_market_as(&settler, "META", DATE, STRIKE_680, false),
        MeridianError::Unauthorized,
    );
    assert_err(
        env.create_market_as(&creator, "META", DATE, STRIKE_680, true),
        MeridianError::Unauthorized,
    );
    assert_err(
        env.create_market_as(&settler, "META", DATE, STRIKE_680, true),
        MeridianError::Unauthorized,
    );
    // Admin cannot use the creator's instruction either: one key per role.
    assert_err(
        env.create_market_as(&admin, "META", DATE, STRIKE_680, false),
        MeridianError::Unauthorized,
    );
    // Creator and settler cannot pause.
    assert_err(env.set_paused(&creator, true), MeridianError::Unauthorized);
    assert_err(env.set_paused(&settler, true), MeridianError::Unauthorized);
    assert!(!env.exists(&market_pda("META", DATE, STRIKE_680)));
    assert!(!env.config().paused);

    // Roles must stay distinct through update_config too.
    let u = ConfigUpdate {
        settler: Some(creator.pubkey()),
        ..Default::default()
    };
    assert_err(
        env.update_config(&admin, u),
        MeridianError::RolesNotDistinct,
    );
    // And at initialisation.
    let mut fresh = Env::bare();
    let mut args = fresh.init_args();
    args.settler = args.market_creator;
    let deployer = fresh.deployer.insecure_clone();
    assert_err(
        fresh.initialize_config(&deployer, args),
        MeridianError::RolesNotDistinct,
    );
    // record_close / admin_settle role checks land with MER-31 / MER-33.
}

#[test]
fn cfg_05_ticker_list_rejects_unknown_or_duplicate_tickers() {
    let mut env = Env::new();
    assert_err(
        env.create_ticker_day("NFLX", DATE, MINT_OPEN, OPEN, CLOSE),
        MeridianError::UnknownTicker,
    );
    assert!(!env.exists(&ticker_day_pda("NFLX", DATE)));

    let admin = env.admin.insecure_clone();
    let mut dup = mag7_args();
    dup[6].symbol = "META".into();
    assert_err(
        env.update_config(
            &admin,
            ConfigUpdate {
                tickers: Some(dup),
                ..Default::default()
            },
        ),
        MeridianError::InvalidTickers,
    );
    let mut eight = mag7_args();
    eight.push(meridian::instructions::TickerArg {
        symbol: "NFLX".into(),
        feed_id: [9; 32],
    });
    assert_err(
        env.update_config(
            &admin,
            ConfigUpdate {
                tickers: Some(eight),
                ..Default::default()
            },
        ),
        MeridianError::InvalidTickers,
    );
    let mut lower = mag7_args();
    lower[0].symbol = "aapl".into();
    assert_err(
        env.update_config(
            &admin,
            ConfigUpdate {
                tickers: Some(lower),
                ..Default::default()
            },
        ),
        MeridianError::InvalidTickers,
    );
    assert_err(
        env.update_config(
            &admin,
            ConfigUpdate {
                tickers: Some(vec![]),
                ..Default::default()
            },
        ),
        MeridianError::InvalidTickers,
    );
    assert_eq!(env.config().tickers[6].symbol_str(), "TSLA");
}

#[test]
fn cfg_07_out_of_range_config_values_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let bad = [
        ConfigUpdate {
            conf_bps_max: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            settle_window_s: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            settle_window_s: Some(-5),
            ..Default::default()
        },
        ConfigUpdate {
            fee_bps: Some(10_001),
            ..Default::default()
        },
        ConfigUpdate {
            fee_bps: Some(1_001),
            ..Default::default()
        },
        ConfigUpdate {
            override_delay_s: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            override_delay_s: Some(-1),
            ..Default::default()
        },
        ConfigUpdate {
            close_tolerance_bps: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            dispute_window_s: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            dispute_bond: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            dispute_resolution_s: Some(0),
            ..Default::default()
        },
        ConfigUpdate {
            admin: Some(Pubkey::default()),
            ..Default::default()
        },
    ];
    for u in bad {
        assert_err(env.update_config(&admin, u), MeridianError::InvalidConfig);
    }
    let c = env.config();
    assert_eq!(
        (
            c.conf_bps_max,
            c.settle_window_s,
            c.fee_bps,
            c.override_delay_s
        ),
        (10, 5, 0, 1800)
    );

    // In-range values are accepted and round-trip.
    let ok = ConfigUpdate {
        fee_bps: Some(1_000),
        override_delay_s: Some(3_600),
        settle_window_s: Some(10),
        conf_bps_max: Some(25),
        close_tolerance_bps: Some(30),
        dispute_window_s: Some(600),
        dispute_bond: Some(50 * USDC),
        dispute_resolution_s: Some(3_600),
        close_source_mode: Some(CloseSourceMode::OracleOfficial),
        ..Default::default()
    };
    env.update_config(&admin, ok).unwrap();
    let c = env.config();
    assert_eq!(c.fee_bps, 1_000);
    assert_eq!(c.override_delay_s, 3_600);
    assert_eq!(c.settle_window_s, 10);
    assert_eq!(c.conf_bps_max, 25);
    assert_eq!(c.close_tolerance_bps, 30);
    assert_eq!(c.dispute_window_s, 600);
    assert_eq!(c.dispute_bond, 50 * USDC);
    assert_eq!(c.dispute_resolution_s, 3_600);
    assert_eq!(c.close_source_mode, CloseSourceMode::OracleOfficial);
}

#[test]
fn cfg_admin_rotation_moves_authority() {
    let mut env = Env::new();
    let old = env.admin.insecure_clone();
    let new_admin = Keypair::new();
    env.svm.airdrop(&new_admin.pubkey(), 1_000_000_000).unwrap();
    env.update_config(
        &old,
        ConfigUpdate {
            admin: Some(new_admin.pubkey()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_err(
        env.update_config(
            &old,
            ConfigUpdate {
                fee_bps: Some(1),
                ..Default::default()
            },
        ),
        MeridianError::Unauthorized,
    );
    env.update_config(
        &new_admin,
        ConfigUpdate {
            fee_bps: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn cfg_rejects_non_usdc_decimals_mint() {
    let mut env = Env::bare();
    let bad_mint = Pubkey::new_unique();
    env.put_mint(bad_mint, 9, None);
    env.usdc_mint = bad_mint;
    let args = env.init_args();
    let deployer = env.deployer.insecure_clone();
    assert_err(
        env.initialize_config(&deployer, args),
        MeridianError::InvalidUsdcMint,
    );
}

#[test]
fn sec_05_only_the_upgrade_authority_can_initialise_config() {
    // On devnet/mainnet the upgrade authority is the Squads multisig (checked by the deploy
    // script, MER-80). Here: init is bound to whoever holds the upgrade authority, so a
    // hot key or an attacker cannot front-run initialisation.
    let mut env = Env::bare();
    let program_data =
        Pubkey::find_program_address(&[meridian::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
    let acc = env.svm.get_account(&program_data).unwrap();
    let state: UpgradeableLoaderState = bincode::deserialize(&acc.data).unwrap();
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address,
            ..
        } => {
            assert_eq!(upgrade_authority_address, Some(env.deployer.pubkey()))
        }
        other => panic!("unexpected {:?}", other),
    }
    let eve = env.user(0);
    let args = env.init_args();
    assert_err(
        env.initialize_config(&eve, args.clone()),
        MeridianError::Unauthorized,
    );
    let creator = env.creator.insecure_clone();
    assert_err(
        env.initialize_config(&creator, args.clone()),
        MeridianError::Unauthorized,
    );
    assert!(!env.exists(&config_pda()));
    let deployer = env.deployer.insecure_clone();
    env.initialize_config(&deployer, args).unwrap();
}
