//! MER-10: initialize_config, update_config and role separation.
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::program::Meridian;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TickerArg {
    pub symbol: String,
    pub feed_id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigArgs {
    pub admin: Pubkey,
    pub market_creator: Pubkey,
    pub settler: Pubkey,
    pub fee_vault: Pubkey,
    pub bond_vault: Pubkey,
    pub tickers: Vec<TickerArg>,
}

/// Every field is optional; only the fields that are `Some` change.
/// `usdc_mint` is fixed at initialisation. Pause has its own instructions.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct ConfigUpdate {
    pub admin: Option<Pubkey>,
    pub market_creator: Option<Pubkey>,
    pub settler: Option<Pubkey>,
    pub fee_bps: Option<u16>,
    pub fee_vault: Option<Pubkey>,
    pub override_delay_s: Option<i64>,
    pub settle_window_s: Option<i64>,
    pub conf_bps_max: Option<u16>,
    pub close_tolerance_bps: Option<u16>,
    pub dispute_window_s: Option<i64>,
    pub dispute_bond: Option<u64>,
    pub dispute_resolution_s: Option<i64>,
    pub bond_vault: Option<Pubkey>,
    pub close_source_mode: Option<CloseSourceMode>,
    pub tickers: Option<Vec<TickerArg>>,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// Must be the program's upgrade authority, so nobody can front-run initialisation.
    #[account(mut)]
    pub deployer: Signer<'info>,

    #[account(
        init,
        payer = deployer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = usdc_mint.decimals == USDC_DECIMALS @ MeridianError::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MeridianError::Unauthorized)]
    pub program: Program<'info, Meridian>,

    #[account(constraint = program_data.upgrade_authority_address == Some(deployer.key()) @ MeridianError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn build_tickers(args: &[TickerArg]) -> Result<[TickerEntry; MAX_TICKERS]> {
    require!(
        !args.is_empty() && args.len() <= MAX_TICKERS,
        MeridianError::InvalidTickers
    );
    let mut out = [TickerEntry::default(); MAX_TICKERS];
    for (i, t) in args.iter().enumerate() {
        let symbol = encode_ticker(&t.symbol).ok_or(MeridianError::InvalidTickers)?;
        require!(
            out[..i].iter().all(|e| e.symbol != symbol),
            MeridianError::InvalidTickers
        );
        require!(t.feed_id != [0u8; 32], MeridianError::InvalidTickers);
        out[i] = TickerEntry {
            symbol,
            feed_id: t.feed_id,
        };
    }
    Ok(out)
}

pub fn validate(c: &Config) -> Result<()> {
    require!(
        c.admin != c.market_creator && c.admin != c.settler && c.market_creator != c.settler,
        MeridianError::RolesNotDistinct
    );
    require!(
        c.admin != Pubkey::default()
            && c.market_creator != Pubkey::default()
            && c.settler != Pubkey::default(),
        MeridianError::InvalidConfig
    );
    require!(c.fee_bps <= MAX_FEE_BPS, MeridianError::InvalidConfig);
    require!(
        c.override_delay_s > 0 && c.override_delay_s <= MAX_OVERRIDE_DELAY_S,
        MeridianError::InvalidConfig
    );
    require!(
        c.settle_window_s > 0 && c.settle_window_s <= MAX_SETTLE_WINDOW_S,
        MeridianError::InvalidConfig
    );
    require!(
        c.conf_bps_max > 0 && c.conf_bps_max <= MAX_BPS,
        MeridianError::InvalidConfig
    );
    require!(
        c.close_tolerance_bps > 0 && c.close_tolerance_bps <= MAX_BPS,
        MeridianError::InvalidConfig
    );
    require!(
        c.dispute_window_s > 0 && c.dispute_window_s <= MAX_DISPUTE_WINDOW_S,
        MeridianError::InvalidConfig
    );
    require!(c.dispute_bond > 0, MeridianError::InvalidConfig);
    require!(
        c.dispute_resolution_s > 0 && c.dispute_resolution_s <= MAX_DISPUTE_RESOLUTION_S,
        MeridianError::InvalidConfig
    );
    require!(
        c.tickers.iter().any(|t| !t.is_empty()),
        MeridianError::InvalidTickers
    );
    Ok(())
}

pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
    let tickers = build_tickers(&args.tickers)?;
    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        admin: args.admin,
        market_creator: args.market_creator,
        settler: args.settler,
        paused: false,
        fee_bps: DEFAULT_FEE_BPS,
        fee_vault: args.fee_vault,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        override_delay_s: DEFAULT_OVERRIDE_DELAY_S,
        settle_window_s: DEFAULT_SETTLE_WINDOW_S,
        conf_bps_max: DEFAULT_CONF_BPS_MAX,
        close_tolerance_bps: DEFAULT_CLOSE_TOLERANCE_BPS,
        dispute_window_s: DEFAULT_DISPUTE_WINDOW_S,
        dispute_bond: DEFAULT_DISPUTE_BOND,
        dispute_resolution_s: DEFAULT_DISPUTE_RESOLUTION_S,
        bond_vault: args.bond_vault,
        close_source_mode: CloseSourceMode::AttestedChecked,
        tickers,
        bump: ctx.bumps.config,
    });
    validate(config)
}

pub fn update_config(ctx: Context<UpdateConfig>, u: ConfigUpdate) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = u.admin {
        c.admin = v;
    }
    if let Some(v) = u.market_creator {
        c.market_creator = v;
    }
    if let Some(v) = u.settler {
        c.settler = v;
    }
    if let Some(v) = u.fee_bps {
        c.fee_bps = v;
    }
    if let Some(v) = u.fee_vault {
        c.fee_vault = v;
    }
    if let Some(v) = u.override_delay_s {
        c.override_delay_s = v;
    }
    if let Some(v) = u.settle_window_s {
        c.settle_window_s = v;
    }
    if let Some(v) = u.conf_bps_max {
        c.conf_bps_max = v;
    }
    if let Some(v) = u.close_tolerance_bps {
        c.close_tolerance_bps = v;
    }
    if let Some(v) = u.dispute_window_s {
        c.dispute_window_s = v;
    }
    if let Some(v) = u.dispute_bond {
        c.dispute_bond = v;
    }
    if let Some(v) = u.dispute_resolution_s {
        c.dispute_resolution_s = v;
    }
    if let Some(v) = u.bond_vault {
        c.bond_vault = v;
    }
    if let Some(v) = u.close_source_mode {
        c.close_source_mode = v;
    }
    if let Some(v) = u.tickers.as_ref() {
        c.tickers = build_tickers(v)?;
    }
    validate(c)
}
