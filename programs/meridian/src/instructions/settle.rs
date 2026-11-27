//! Per-strike settlement (MER-32, ADM-07), redeem and void (MER-34).
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::*;
use crate::instructions::market::ticker_seed;
use crate::instructions::token_ops::*;
use crate::invariants::{assert_invariants, payout, MarketSnapshot};
use crate::settlement::{outcome_for, straddles};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(address = market.ticker_day @ MeridianError::AccountMismatch)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,
}

/// Writes the outcome from the ticker-day's FINAL price and checks the invariants.
/// Shared by both settle paths; the caller emits the returned event.
fn apply_outcome(
    key: Pubkey,
    td: &TickerDay,
    m: &mut Market,
    vault: &TokenAccount,
    yes_mint: &Mint,
    no_mint: &Mint,
    outcome: Outcome,
) -> Result<MarketSettled> {
    let (py, pn) = payout(outcome);
    let owed = (yes_mint.supply as u128) * (py as u128) + (no_mint.supply as u128) * (pn as u128);
    m.status = MarketStatus::Settled;
    m.outcome = outcome;
    m.settle_price = td.price;
    m.settle_expo = td.expo;
    // = winning supply x $1 (spec 4.2); equal to pairs x $1 before this point.
    m.collateral_accounted = u64::try_from(owed).map_err(|_| MeridianError::Overflow)?;
    assert_invariants(&MarketSnapshot::of(
        m,
        vault.amount,
        yes_mint.supply,
        no_mint.supply,
    ))?;
    let seq = m.next_seq()?;
    Ok(MarketSettled {
        market: key,
        slot: Clock::get()?.slot,
        seq,
        outcome,
        settle_price: m.settle_price,
    })
}

/// Common guards. Returns `false` when the market is already settled or void: a repeat
/// call is a clean no-op so cranks can retry and race safely (SET-07, SJ-07).
fn ready_to_settle(td: &TickerDay, m: &Market) -> Result<bool> {
    if matches!(m.status, MarketStatus::Settled | MarketStatus::Void) {
        return Ok(false);
    }
    require!(
        td.status == TickerDayStatus::Final,
        MeridianError::TickerDayNotFinal
    );
    Ok(true)
}

/// Permissionless (D10). Copies the FINAL price from the strike's `TickerDay` (never
/// reads the oracle) and writes YES if `price >= strike`, else NO. Refuses with
/// `ConfidenceStraddle` when the Pyth confidence band straddles the strike (D27, A30);
/// that strike waits for `admin_settle_market`. Admin and dispute-corrected prices are
/// multisig decisions and skip the band check (ADM-02).
pub fn settle_market(mut ctx: Context<SettleMarket>) -> Result<()> {
    let td = &ctx.accounts.ticker_day;
    let m = &ctx.accounts.market;
    if !ready_to_settle(td, m)? {
        return Ok(());
    }
    let band_applies =
        td.close_source != CloseSource::Admin && td.final_basis != FinalBasis::Corrected;
    if band_applies {
        require!(
            !straddles(td.price, td.expo, td.ref_conf, m.strike_cents)?,
            MeridianError::ConfidenceStraddle
        );
    }
    let outcome = outcome_for(td.price, td.expo, m.strike_cents)?;
    let a = &mut ctx.accounts;
    let key = a.market.key();
    let ev = apply_outcome(
        key,
        &a.ticker_day,
        &mut a.market,
        &a.vault,
        &a.yes_mint,
        &a.no_mint,
        outcome,
    )?;
    emit_cpi!(ev);
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AdminSettleMarket<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(address = market.ticker_day @ MeridianError::AccountMismatch)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,
}

/// ADM-07: the admin path for a strike `settle_market` refused (D27: "strikes inside
/// `[close - conf, close + conf]` go to the multisig"). Admin (multisig) only; only for a
/// strike inside the band, from the same FINAL ticker-day price; the multisig picks
/// YES or NO from the exchange's official close. Other strikes are untouched (D11).
pub fn admin_settle_market(mut ctx: Context<AdminSettleMarket>, outcome: Outcome) -> Result<()> {
    require!(
        matches!(outcome, Outcome::Yes | Outcome::No),
        MeridianError::InvalidConfig
    );
    let a = &mut ctx.accounts;
    if !ready_to_settle(&a.ticker_day, &a.market)? {
        return Ok(());
    }
    let td = &a.ticker_day;
    require!(
        td.close_source != CloseSource::Admin
            && td.final_basis != FinalBasis::Corrected
            && straddles(td.price, td.expo, td.ref_conf, a.market.strike_cents)?,
        MeridianError::NotInConfidenceBand
    );
    let key = a.market.key();
    let ev = apply_outcome(
        key,
        &a.ticker_day,
        &mut a.market,
        &a.vault,
        &a.yes_mint,
        &a.no_mint,
        outcome,
    )?;
    emit_cpi!(ev);
    Ok(())
}

// ---------------------------------------------------------------- void_market

#[event_cpi]
#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,
}

/// Admin only, only for a market with no fills (D20, A24). Outcome VOID: Yes and No each
/// redeem for $0.50. Voiding stops minting and trading at once (both need TRADING).
pub fn void_market(mut ctx: Context<VoidMarket>) -> Result<()> {
    let a = &mut ctx.accounts;
    let m = &mut a.market;
    require!(
        matches!(m.status, MarketStatus::Trading | MarketStatus::Halted),
        MeridianError::MarketSettled
    );
    require!(m.total_trades == 0, MeridianError::MarketHasTrades);
    m.status = MarketStatus::Void;
    m.outcome = Outcome::Void;
    // (yes + no) x $0.50 = pairs x $1: unchanged.
    assert_invariants(&MarketSnapshot::of(
        m,
        a.vault.amount,
        a.yes_mint.supply,
        a.no_mint.supply,
    ))?;
    let seq = m.next_seq()?;
    let ev = MarketVoided {
        market: m.key(),
        slot: Clock::get()?.slot,
        seq,
    };
    emit_cpi!(ev);
    Ok(())
}

// ---------------------------------------------------------------- redeem

#[event_cpi]
#[derive(Accounts)]
pub struct Redeem<'info> {
    pub user: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, ticker_seed(&market.ticker), &market.date.to_le_bytes(), &market.strike_cents.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// Mint checked: tokens of another market are refused (SEC-04).
    #[account(mut, token::mint = market.yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = market.no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Burns `yes_n` Yes and `no_n` No and pays $1 per winning token ($0.50 each if VOID).
/// SETTLED or VOID only; works forever, while paused and after `close_book` (D30, A27).
pub fn redeem(mut ctx: Context<Redeem>, yes_n: u64, no_n: u64) -> Result<()> {
    require!(yes_n > 0 || no_n > 0, MeridianError::ZeroQuantity);
    let a = &mut ctx.accounts;
    require!(
        matches!(a.market.status, MarketStatus::Settled | MarketStatus::Void),
        MeridianError::MarketNotSettled
    );
    require!(
        a.user_yes.amount >= yes_n && a.user_no.amount >= no_n,
        MeridianError::InsufficientTokens
    );
    let (py, pn) = payout(a.market.outcome);
    let paid = (yes_n as u128) * (py as u128) + (no_n as u128) * (pn as u128);
    let paid = u64::try_from(paid).map_err(|_| MeridianError::Overflow)?;
    let accounted = a
        .market
        .collateral_accounted
        .checked_sub(paid)
        .ok_or(MeridianError::InvariantViolated)?;

    let tp = a.token_program.to_account_info();
    let user = a.user.to_account_info();
    burn(
        &tp,
        &a.yes_mint.to_account_info(),
        &a.user_yes.to_account_info(),
        &user,
        None,
        yes_n,
    )?;
    burn(
        &tp,
        &a.no_mint.to_account_info(),
        &a.user_no.to_account_info(),
        &user,
        None,
        no_n,
    )?;
    let signer = MarketSigner::new(&a.market);
    transfer(
        &tp,
        &a.vault.to_account_info(),
        &a.user_usdc.to_account_info(),
        &a.market.to_account_info(),
        Some(&signer),
        paid,
    )?;
    a.market.collateral_accounted = accounted;

    a.vault.reload()?;
    a.yes_mint.reload()?;
    a.no_mint.reload()?;
    assert_invariants(&MarketSnapshot::of(
        &a.market,
        a.vault.amount,
        a.yes_mint.supply,
        a.no_mint.supply,
    ))?;
    let seq = a.market.next_seq()?;
    let ev = Redeemed {
        market: a.market.key(),
        slot: Clock::get()?.slot,
        seq,
        owner: a.user.key(),
        yes_n,
        no_n,
        paid,
    };
    emit_cpi!(ev);
    Ok(())
}
