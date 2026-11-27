//! MER-15: pause / unpause (D30: pause stops only entry: mint_pair and new orders).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::events::{Paused, Unpaused};
use crate::state::Config;

#[event_cpi]
#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(address = config.admin @ MeridianError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = paused;
    let market = config.key();
    let slot = Clock::get()?.slot;
    let by = ctx.accounts.admin.key();
    if paused {
        emit_cpi!(Paused {
            market,
            slot,
            seq: 0,
            by
        });
    } else {
        emit_cpi!(Unpaused {
            market,
            slot,
            seq: 0,
            by
        });
    }
    Ok(())
}
