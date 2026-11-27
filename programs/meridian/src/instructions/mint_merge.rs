//! MER-13: mint_pair and merge_pair with accounted collateral (D14, D17, D24, D26, D30).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::{PairMerged, PairMinted, Via};
use crate::instructions::market::ticker_seed;
use crate::invariants::{assert_invariants, MarketSnapshot};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
pub struct MintMerge<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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

    #[account(mut, address = market.yes_mint @ MeridianError::AccountMismatch)]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.no_mint @ MeridianError::AccountMismatch)]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = market.vault @ MeridianError::AccountMismatch)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn collateral_for(n: u64) -> Result<u64> {
    n.checked_mul(MICRO_USDC_PER_PAIR)
        .ok_or_else(|| error!(MeridianError::Overflow))
}

fn check_invariants(a: &mut MintMerge) -> Result<()> {
    a.vault.reload()?;
    a.yes_mint.reload()?;
    a.no_mint.reload()?;
    assert_invariants(&MarketSnapshot::of(
        &a.market,
        a.vault.amount,
        a.yes_mint.supply,
        a.no_mint.supply,
    ))
}

pub fn mint_pair(mut ctx: Context<MintMerge>, n: u64) -> Result<()> {
    require!(n > 0, MeridianError::ZeroQuantity);
    let a = &ctx.accounts;
    require!(!a.config.paused, MeridianError::Paused);
    require!(
        a.market.status == MarketStatus::Trading,
        MeridianError::MarketNotTrading
    );
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= a.ticker_day.mint_open_time,
        MeridianError::MintNotOpen
    );
    require!(
        clock.unix_timestamp < a.ticker_day.close_time,
        MeridianError::MarketClosed
    );

    let amount = collateral_for(n)?;
    let pairs = a
        .market
        .pairs_outstanding
        .checked_add(n)
        .ok_or(MeridianError::Overflow)?;
    let accounted = a
        .market
        .collateral_accounted
        .checked_add(amount)
        .ok_or(MeridianError::Overflow)?;
    let minted = a
        .market
        .total_minted
        .checked_add(n)
        .ok_or(MeridianError::Overflow)?;

    token::transfer(
        CpiContext::new(
            a.token_program.to_account_info(),
            Transfer {
                from: a.user_usdc.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        amount,
    )?;

    let m = &a.market;
    let date = m.date.to_le_bytes();
    let strike = m.strike_cents.to_le_bytes();
    let seeds: &[&[u8]] = &[
        MARKET_SEED,
        ticker_seed(&m.ticker),
        &date,
        &strike,
        &[m.bump],
    ];
    let signer = &[seeds];
    for (mint, to) in [(&a.yes_mint, &a.user_yes), (&a.no_mint, &a.user_no)] {
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                MintTo {
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: m.to_account_info(),
                },
                signer,
            ),
            n,
        )?;
    }

    let a = &mut ctx.accounts;
    a.market.pairs_outstanding = pairs;
    a.market.collateral_accounted = accounted;
    a.market.total_minted = minted;
    check_invariants(a)?;

    let seq = a.market.next_seq()?;
    let ev = PairMinted {
        market: a.market.key(),
        slot: clock.slot,
        seq,
        owner: a.user.key(),
        n,
        via: Via::Direct,
    };
    emit_cpi!(ev);
    Ok(())
}

pub fn merge_pair(mut ctx: Context<MintMerge>, n: u64) -> Result<()> {
    require!(n > 0, MeridianError::ZeroQuantity);
    let a = &ctx.accounts;
    // Allowed while paused and after the halt; only settlement closes it (use redeem then).
    require!(
        a.market.status != MarketStatus::Settled && a.market.status != MarketStatus::Void,
        MeridianError::MarketSettled
    );
    require!(
        a.user_yes.amount >= n && a.user_no.amount >= n,
        MeridianError::InsufficientTokens
    );

    let amount = collateral_for(n)?;
    let pairs = a
        .market
        .pairs_outstanding
        .checked_sub(n)
        .ok_or(MeridianError::Overflow)?;
    let accounted = a
        .market
        .collateral_accounted
        .checked_sub(amount)
        .ok_or(MeridianError::Overflow)?;

    for (mint, from) in [(&a.yes_mint, &a.user_yes), (&a.no_mint, &a.user_no)] {
        token::burn(
            CpiContext::new(
                a.token_program.to_account_info(),
                Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            n,
        )?;
    }

    let m = &a.market;
    let date = m.date.to_le_bytes();
    let strike = m.strike_cents.to_le_bytes();
    let seeds: &[&[u8]] = &[
        MARKET_SEED,
        ticker_seed(&m.ticker),
        &date,
        &strike,
        &[m.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer {
                from: a.vault.to_account_info(),
                to: a.user_usdc.to_account_info(),
                authority: m.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let a = &mut ctx.accounts;
    a.market.pairs_outstanding = pairs;
    a.market.collateral_accounted = accounted;
    check_invariants(a)?;

    let clock = Clock::get()?;
    let seq = a.market.next_seq()?;
    let ev = PairMerged {
        market: a.market.key(),
        slot: clock.slot,
        seq,
        owner: a.user.key(),
        n,
        via: Via::Direct,
    };
    emit_cpi!(ev);
    Ok(())
}
