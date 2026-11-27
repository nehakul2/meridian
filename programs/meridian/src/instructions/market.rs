//! MER-12: create_strike_market (market_creator) and add_strike (admin), one code path.
//! There is deliberately no instruction that changes `strike_cents` after creation (D20, A24).
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::MarketCreated;
use crate::invariants::{assert_invariants, MarketSnapshot};
use crate::state::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(strike_cents: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// `market_creator` for create_strike_market, `admin` for add_strike (checked in the handler).
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub ticker_day: Box<Account<'info, TickerDay>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, ticker_seed(&ticker_day.ticker), &ticker_day.date.to_le_bytes(), &strike_cents.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OrderBook::INIT_SPACE,
        seeds = [BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub book: Box<Account<'info, OrderBook>>,

    #[account(address = config.usdc_mint @ MeridianError::AccountMismatch)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// The ticker bytes used in PDA seeds: the symbol without zero padding.
pub fn ticker_seed(ticker: &[u8; TICKER_LEN]) -> &[u8] {
    let len = ticker.iter().position(|b| *b == 0).unwrap_or(TICKER_LEN);
    &ticker[..len]
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CreateRole {
    Creator,
    Admin,
}

pub fn create_market(
    ctx: Context<CreateMarket>,
    strike_cents: u64,
    role: CreateRole,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let expected = match role {
        CreateRole::Creator => config.market_creator,
        CreateRole::Admin => config.admin,
    };
    require_keys_eq!(
        ctx.accounts.authority.key(),
        expected,
        MeridianError::Unauthorized
    );

    let market = &mut ctx.accounts.market;
    if market.ticker_day != Pubkey::default() {
        // Idempotent (A25): existing market is success, no state change.
        return Ok(());
    }

    let td = &mut ctx.accounts.ticker_day;
    // The ticker-day must be the canonical PDA for its own (ticker, date).
    let (td_key, _) = Pubkey::find_program_address(
        &[
            TICKER_DAY_SEED,
            ticker_seed(&td.ticker),
            &td.date.to_le_bytes(),
        ],
        ctx.program_id,
    );
    require_keys_eq!(td.key(), td_key, MeridianError::AccountMismatch);
    require!(strike_cents > 0, MeridianError::InvalidStrike);
    require!(
        td.status == TickerDayStatus::Open,
        MeridianError::TickerDayNotOpen
    );
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < td.close_time,
        MeridianError::MarketClosed
    );

    td.strike_count = td
        .strike_count
        .checked_add(1)
        .ok_or(MeridianError::Overflow)?;

    market.set_inner(Market {
        ticker_day: td.key(),
        ticker: td.ticker,
        date: td.date,
        strike_cents,
        yes_mint: ctx.accounts.yes_mint.key(),
        no_mint: ctx.accounts.no_mint.key(),
        vault: ctx.accounts.vault.key(),
        book: ctx.accounts.book.key(),
        pairs_outstanding: 0,
        collateral_accounted: 0,
        status: MarketStatus::Trading,
        outcome: Outcome::None,
        settle_price: 0,
        settle_expo: 0,
        total_minted: 0,
        total_trades: 0,
        seq: 0,
        created_at: clock.unix_timestamp,
        bump: ctx.bumps.market,
        vault_bump: ctx.bumps.vault,
        yes_mint_bump: ctx.bumps.yes_mint,
        no_mint_bump: ctx.bumps.no_mint,
    });

    let book = &mut ctx.accounts.book;
    book.market = market.key();
    book.next_order_id = 1;
    book.order_count = 0;
    book.bump = ctx.bumps.book;

    assert_invariants(&MarketSnapshot::of(
        market,
        ctx.accounts.vault.amount,
        ctx.accounts.yes_mint.supply,
        ctx.accounts.no_mint.supply,
    ))?;

    let seq = market.next_seq()?;
    let ev = MarketCreated {
        market: market.key(),
        slot: clock.slot,
        seq,
        ticker_day: td.key(),
        ticker: td.ticker,
        date: td.date,
        strike_cents,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        book: market.book,
        created_by: ctx.accounts.authority.key(),
    };
    emit_cpi!(ev);
    Ok(())
}
