//! The ticker-day close: record_close (MER-31), admin_settle (MER-33) and the dispute
//! window (MER-37: raise_dispute, resolve_dispute, finalize_close).
//!
//! Status moves only forward: OPEN -> PROVISIONAL -> [DISPUTED ->] FINAL (spec 4.3 #6).
//! The first writer of OPEN -> PROVISIONAL wins (record_close or admin_settle, ADM-04).
//! The price changes at most once after that, by `resolve_dispute(Correct)`, and never
//! after FINAL. Strikes settle only from FINAL (D8).
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::*;
use crate::instructions::token_ops::transfer_signed;
use crate::settlement::*;
use crate::state::*;

/// The attested official closing-auction price (D3), at the reference update's exponent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfficialClose {
    pub price: i64,
    pub expo: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Recorded price stands; the bond goes to the fee vault.
    Uphold,
    /// Price replaced once; `original_price` keeps the old one; the bond goes back.
    Correct { price: i64, expo: i32 },
}

// ---------------------------------------------------------------- record_close

#[event_cpi]
#[derive(Accounts)]
pub struct RecordClose<'info> {
    #[account(address = config.settler @ MeridianError::Unauthorized)]
    pub settler: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    /// CHECK: a Pyth Receiver `PriceUpdateV2`; owner, discriminator and verification
    /// level are checked by `settlement::read_price_update`.
    pub price_update: UncheckedAccount<'info>,
}

/// Settler only (D10). Records the official close, cross-checked against a fully
/// verified Pyth update stamped in `[close_time, close_time + settle_window_s]` (D1, D3,
/// D13, spec 4.7). A failed transaction changes nothing, so the settler can resubmit the
/// same official close and update (D2).
pub fn record_close(ctx: Context<RecordClose>, official: Option<OfficialClose>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let td = &ctx.accounts.ticker_day;
    require!(
        td.status == TickerDayStatus::Open,
        MeridianError::TickerDayNotOpen
    );
    require!(now >= td.close_time, MeridianError::CloseNotReached);

    let u = read_price_update(&ctx.accounts.price_update.to_account_info())?;
    let entry = cfg
        .tickers
        .iter()
        .find(|t| !t.is_empty() && t.symbol == td.ticker)
        .ok_or(MeridianError::UnknownTicker)?;
    require!(u.feed_id == entry.feed_id, MeridianError::FeedMismatch);
    // Staleness is measured against the close, not the wall clock (ORC-13).
    let window_end = td
        .close_time
        .checked_add(cfg.settle_window_s)
        .ok_or(MeridianError::Overflow)?;
    require!(
        u.publish_time >= td.close_time && u.publish_time <= window_end,
        MeridianError::PublishTimeOutsideWindow
    );
    check_price(u.price, u.expo)?;
    require!(
        conf_within(u.price, u.conf, cfg.conf_bps_max),
        MeridianError::ConfidenceTooWide
    );

    let (price, source) = match cfg.close_source_mode {
        CloseSourceMode::AttestedChecked => {
            let o = official.ok_or(MeridianError::OfficialCloseRequired)?;
            check_price(o.price, o.expo)?;
            require!(o.expo == u.expo, MeridianError::ExpoMismatch);
            require!(
                within_tolerance(o.price, u.price, u.conf, cfg.close_tolerance_bps),
                MeridianError::CrossCheckFailed
            );
            (o.price, CloseSource::AttestedChecked)
        }
        CloseSourceMode::OracleOfficial => {
            // The configured feed is the official-close feed; its price is the close.
            require!(official.is_none(), MeridianError::OfficialCloseNotAllowed);
            (u.price, CloseSource::OracleOfficial)
        }
    };

    let by = ctx.accounts.settler.key();
    let td = &mut ctx.accounts.ticker_day;
    td.status = TickerDayStatus::Provisional;
    td.recorded_at = now;
    td.price = price;
    td.expo = u.expo;
    td.original_price = price;
    td.close_source = source;
    td.ref_price = u.price;
    td.ref_conf = u.conf;
    td.ref_publish_time = u.publish_time;
    td.recorded_by = by;

    emit_cpi!(CloseRecorded {
        market: td.key(),
        slot: Clock::get()?.slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        price,
        expo: u.expo,
        conf: u.conf,
        publish_time: u.publish_time,
        by,
        r#override: false,
    });
    Ok(())
}

// ---------------------------------------------------------------- admin_settle

#[event_cpi]
#[derive(Accounts)]
pub struct AdminSettle<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,
}

/// Admin (multisig) only (A22). Allowed once the close is still unrecorded at
/// `close_time + override_delay_s` (D4). No price bound on-chain (D19); the price goes
/// through the dispute window like an oracle price (D8).
pub fn admin_settle(ctx: Context<AdminSettle>, price: i64, expo: i32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let td = &ctx.accounts.ticker_day;
    require!(
        td.status == TickerDayStatus::Open,
        MeridianError::TickerDayNotOpen
    );
    let unlock = td
        .close_time
        .checked_add(cfg.override_delay_s)
        .ok_or(MeridianError::Overflow)?;
    require!(now >= unlock, MeridianError::OverrideTooEarly);
    check_price(price, expo)?;

    let by = ctx.accounts.admin.key();
    let td = &mut ctx.accounts.ticker_day;
    td.status = TickerDayStatus::Provisional;
    td.recorded_at = now;
    td.price = price;
    td.expo = expo;
    td.original_price = price;
    td.close_source = CloseSource::Admin;
    td.ref_price = 0;
    td.ref_conf = 0;
    td.ref_publish_time = 0;
    td.recorded_by = by;

    emit_cpi!(CloseRecorded {
        market: td.key(),
        slot: Clock::get()?.slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        price,
        expo,
        conf: 0,
        publish_time: 0,
        by,
        r#override: true,
    });
    Ok(())
}

// ---------------------------------------------------------------- raise_dispute

/// The bond vault must be `Config.bond_vault`, hold USDC, and be owned by the bond
/// authority PDA, so a bond can always be returned or forwarded.
fn check_bond_vault(
    cfg: &Config,
    vault: &TokenAccount,
    key: &Pubkey,
    program_id: &Pubkey,
) -> Result<()> {
    let (authority, _) = Pubkey::find_program_address(&[BOND_AUTHORITY_SEED], program_id);
    require!(
        *key == cfg.bond_vault && vault.mint == cfg.usdc_mint && vault.owner == authority,
        MeridianError::InvalidBondVault
    );
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub disputer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    /// One per ticker-day: a second `init` fails (DSP-02).
    #[account(
        init,
        payer = disputer,
        space = 8 + Dispute::INIT_SPACE,
        seeds = [DISPUTE_SEED, ticker_day.key().as_ref()],
        bump,
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = disputer)]
    pub disputer_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Anyone, while the close is PROVISIONAL and `now < recorded_at + dispute_window_s`.
/// Moves `dispute_bond` USDC to the bond vault and blocks finalisation (D8).
pub fn raise_dispute(ctx: Context<RaiseDispute>, evidence_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let cfg = &a.config;
    check_bond_vault(cfg, &a.bond_vault, &a.bond_vault.key(), ctx.program_id)?;
    require!(
        a.ticker_day.status == TickerDayStatus::Provisional,
        MeridianError::NotProvisional
    );
    let window_end = a
        .ticker_day
        .recorded_at
        .checked_add(cfg.dispute_window_s)
        .ok_or(MeridianError::Overflow)?;
    require!(now < window_end, MeridianError::DisputeWindowClosed);
    let bond = cfg.dispute_bond;

    anchor_spl::token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: a.disputer_usdc.to_account_info(),
                to: a.bond_vault.to_account_info(),
                authority: a.disputer.to_account_info(),
            },
        ),
        bond,
    )?;

    let by = a.disputer.key();
    let td_key = a.ticker_day.key();
    let dispute_bump = ctx.bumps.dispute;
    ctx.accounts.dispute.set_inner(Dispute {
        ticker_day: td_key,
        disputer: by,
        bond,
        raised_at: now,
        evidence_hash,
        resolved: false,
        bump: dispute_bump,
    });
    let td = &mut ctx.accounts.ticker_day;
    td.status = TickerDayStatus::Disputed;

    emit_cpi!(DisputeRaised {
        market: td_key,
        slot: Clock::get()?.slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        by,
        bond,
        evidence_hash,
    });
    Ok(())
}

// ---------------------------------------------------------------- resolve_dispute

#[event_cpi]
#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    #[account(
        mut,
        seeds = [DISPUTE_SEED, ticker_day.key().as_ref()],
        bump = dispute.bump,
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(mut, address = config.bond_vault @ MeridianError::InvalidBondVault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA signer for the bond vault; seeds checked.
    #[account(seeds = [BOND_AUTHORITY_SEED], bump)]
    pub bond_authority: UncheckedAccount<'info>,

    /// Uphold: the bond goes here.
    #[account(mut, address = config.fee_vault @ MeridianError::AccountMismatch)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,

    /// Correct: the bond goes back here.
    #[account(mut, token::mint = config.usdc_mint, token::authority = dispute.disputer)]
    pub disputer_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Admin (multisig) only, before `raised_at + dispute_resolution_s`. Uphold keeps the
/// price and forwards the bond to the fee vault; Correct replaces the price once, keeps
/// `original_price` and returns the bond. Either way the close becomes FINAL.
pub fn resolve_dispute(ctx: Context<ResolveDispute>, resolution: Resolution) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.bond_authority;
    let a = &ctx.accounts;
    require!(
        a.ticker_day.status == TickerDayStatus::Disputed && !a.dispute.resolved,
        MeridianError::NotDisputed
    );
    let deadline = a
        .dispute
        .raised_at
        .checked_add(a.config.dispute_resolution_s)
        .ok_or(MeridianError::Overflow)?;
    require!(now < deadline, MeridianError::ResolutionDeadlinePassed);

    let (dest, basis, result) = match resolution {
        Resolution::Uphold => (
            a.fee_vault.to_account_info(),
            FinalBasis::Upheld,
            DisputeResult::Upheld,
        ),
        Resolution::Correct { price, expo } => {
            check_price(price, expo)?;
            (
                a.disputer_usdc.to_account_info(),
                FinalBasis::Corrected,
                DisputeResult::Corrected,
            )
        }
    };
    transfer_signed(
        &a.token_program.to_account_info(),
        &a.bond_vault.to_account_info(),
        &dest,
        &a.bond_authority.to_account_info(),
        &[BOND_AUTHORITY_SEED, &[bump]],
        a.dispute.bond,
    )?;

    let td_key = a.ticker_day.key();
    let td = &mut ctx.accounts.ticker_day;
    let old_price = td.price;
    if let Resolution::Correct { price, expo } = resolution {
        td.original_price = td.price;
        td.price = price;
        td.expo = expo;
    }
    td.status = TickerDayStatus::Final;
    td.final_basis = basis;
    td.finalized_at = now;
    ctx.accounts.dispute.resolved = true;

    let slot = Clock::get()?.slot;
    let td = &ctx.accounts.ticker_day;
    emit_cpi!(DisputeResolved {
        market: td_key,
        slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        result,
        old_price,
        new_price: td.price,
    });
    emit_cpi!(CloseFinalized {
        market: td_key,
        slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        price: td.price,
        basis,
    });
    Ok(())
}

// ---------------------------------------------------------------- finalize_close

#[event_cpi]
#[derive(Accounts)]
pub struct FinalizeClose<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    /// The accounts below are needed only on the deadline path (DISPUTED).
    #[account(
        mut,
        seeds = [DISPUTE_SEED, ticker_day.key().as_ref()],
        bump = dispute.bump,
    )]
    pub dispute: Option<Box<Account<'info, Dispute>>>,

    #[account(mut, address = config.bond_vault @ MeridianError::InvalidBondVault)]
    pub bond_vault: Option<Box<Account<'info, TokenAccount>>>,

    /// CHECK: PDA signer for the bond vault; seeds checked.
    #[account(seeds = [BOND_AUTHORITY_SEED], bump)]
    pub bond_authority: Option<UncheckedAccount<'info>>,

    #[account(mut, token::mint = config.usdc_mint)]
    pub disputer_usdc: Option<Box<Account<'info, TokenAccount>>>,

    pub token_program: Option<Program<'info, Token>>,
}

/// Anyone. PROVISIONAL past the window -> FINAL `UNDISPUTED`. DISPUTED past the
/// resolution deadline -> FINAL `DEADLINE`: the recorded price stands and the bond goes
/// back to the disputer, so an absent admin never strands funds (D8).
pub fn finalize_close(ctx: Context<FinalizeClose>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let basis = match a.ticker_day.status {
        TickerDayStatus::Provisional => {
            let end = a
                .ticker_day
                .recorded_at
                .checked_add(a.config.dispute_window_s)
                .ok_or(MeridianError::Overflow)?;
            require!(now >= end, MeridianError::DisputeWindowOpen);
            FinalBasis::Undisputed
        }
        TickerDayStatus::Disputed => {
            let d = a.dispute.as_ref().ok_or(MeridianError::AccountMismatch)?;
            let deadline = d
                .raised_at
                .checked_add(a.config.dispute_resolution_s)
                .ok_or(MeridianError::Overflow)?;
            require!(now >= deadline, MeridianError::ResolutionDeadlineNotReached);
            let vault = a
                .bond_vault
                .as_ref()
                .ok_or(MeridianError::AccountMismatch)?;
            let auth = a
                .bond_authority
                .as_ref()
                .ok_or(MeridianError::AccountMismatch)?;
            let to = a
                .disputer_usdc
                .as_ref()
                .ok_or(MeridianError::AccountMismatch)?;
            require_keys_eq!(to.owner, d.disputer, MeridianError::AccountMismatch);
            let tp = a
                .token_program
                .as_ref()
                .ok_or(MeridianError::AccountMismatch)?;
            let bump = ctx
                .bumps
                .bond_authority
                .ok_or(MeridianError::AccountMismatch)?;
            transfer_signed(
                &tp.to_account_info(),
                &vault.to_account_info(),
                &to.to_account_info(),
                &auth.to_account_info(),
                &[BOND_AUTHORITY_SEED, &[bump]],
                d.bond,
            )?;
            FinalBasis::Deadline
        }
        TickerDayStatus::Open => return err!(MeridianError::NotProvisional),
        TickerDayStatus::Final => return err!(MeridianError::TickerDayNotOpen),
    };
    if let Some(d) = ctx.accounts.dispute.as_mut() {
        if basis == FinalBasis::Deadline {
            d.resolved = true;
        }
    }
    let td_key = ctx.accounts.ticker_day.key();
    let td = &mut ctx.accounts.ticker_day;
    td.status = TickerDayStatus::Final;
    td.final_basis = basis;
    td.finalized_at = now;
    emit_cpi!(CloseFinalized {
        market: td_key,
        slot: Clock::get()?.slot,
        seq: 0,
        ticker: td.ticker,
        date: td.date,
        price: td.price,
        basis,
    });
    Ok(())
}
