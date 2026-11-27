//! MER-11: create_ticker_day with calendar times (D25, D26, D31).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(ticker: String, date: u32)]
pub struct CreateTickerDay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(address = config.market_creator @ MeridianError::Unauthorized)]
    pub creator: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + TickerDay::INIT_SPACE,
        seeds = [TICKER_DAY_SEED, ticker.as_bytes(), &date.to_le_bytes()],
        bump,
    )]
    pub ticker_day: Account<'info, TickerDay>,

    pub system_program: Program<'info, System>,
}

pub fn create_ticker_day(
    ctx: Context<CreateTickerDay>,
    ticker: String,
    date: u32,
    mint_open_time: i64,
    open_time: i64,
    close_time: i64,
) -> Result<()> {
    require!(
        ctx.accounts.config.has_ticker(&ticker),
        MeridianError::UnknownTicker
    );
    let td = &mut ctx.accounts.ticker_day;
    if td.date != 0 {
        // Idempotent (A25): an existing ticker-day is success and is never changed.
        return Ok(());
    }
    require!(valid_date(date), MeridianError::InvalidDate);
    require!(
        mint_open_time <= open_time && open_time < close_time && mint_open_time > 0,
        MeridianError::InvalidTimes
    );

    td.set_inner(TickerDay {
        ticker: encode_ticker(&ticker).ok_or(MeridianError::UnknownTicker)?,
        date,
        mint_open_time,
        open_time,
        close_time,
        status: TickerDayStatus::Open,
        final_basis: FinalBasis::None,
        recorded_at: 0,
        price: 0,
        expo: 0,
        original_price: 0,
        close_source: CloseSource::None,
        ref_price: 0,
        ref_conf: 0,
        ref_publish_time: 0,
        recorded_by: Pubkey::default(),
        strike_count: 0,
        finalized_at: 0,
        bump: ctx.bumps.ticker_day,
    });
    Ok(())
}
