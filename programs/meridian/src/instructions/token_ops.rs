//! Small SPL Token CPI helpers and the Market PDA signer shared by the trade paths.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Burn, MintTo, Transfer};

use crate::constants::*;
use crate::state::Market;

/// Owned copies of the Market PDA seeds, so `seeds()` can borrow them.
pub struct MarketSigner {
    ticker: [u8; TICKER_LEN],
    tlen: usize,
    date: [u8; 4],
    strike: [u8; 8],
    bump: [u8; 1],
}

impl MarketSigner {
    pub fn new(m: &Market) -> Self {
        Self {
            ticker: m.ticker,
            tlen: m.ticker.iter().position(|b| *b == 0).unwrap_or(TICKER_LEN),
            date: m.date.to_le_bytes(),
            strike: m.strike_cents.to_le_bytes(),
            bump: [m.bump],
        }
    }

    pub fn seeds(&self) -> [&[u8]; 5] {
        [
            MARKET_SEED,
            &self.ticker[..self.tlen],
            &self.date,
            &self.strike,
            &self.bump,
        ]
    }
}

pub fn transfer<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    signer: Option<&MarketSigner>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accs = Transfer {
        from: from.clone(),
        to: to.clone(),
        authority: authority.clone(),
    };
    match signer {
        Some(s) => {
            let seeds = s.seeds();
            let signer_seeds: &[&[&[u8]]] = &[&seeds];
            token::transfer(
                CpiContext::new_with_signer(token_program.clone(), accs, signer_seeds),
                amount,
            )
        }
        None => token::transfer(CpiContext::new(token_program.clone(), accs), amount),
    }
}

/// Transfer signed by an arbitrary program PDA (the bond authority, MER-37).
pub fn transfer_signed<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer {
                from: from.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// The owner (signing) approves `delegate` to move up to `amount` from `account`.
/// Used by buy_no_limit so `prune_orders` can convert an unfilled BUY_NO order's Yes and
/// the owner's No to USDC after close without the owner signing (D15, MER-35).
pub fn approve<'a>(
    token_program: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    delegate: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    amount: u64,
) -> Result<()> {
    token::approve(
        CpiContext::new(
            token_program.clone(),
            Approve {
                to: account.clone(),
                delegate: delegate.clone(),
                authority: owner.clone(),
            },
        ),
        amount,
    )
}

pub fn mint_to<'a>(
    token_program: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    market: &AccountInfo<'a>,
    signer: &MarketSigner,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds = signer.seeds();
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: mint.clone(),
                to: to.clone(),
                authority: market.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

pub fn burn<'a>(
    token_program: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    signer: Option<&MarketSigner>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accs = Burn {
        mint: mint.clone(),
        from: from.clone(),
        authority: authority.clone(),
    };
    match signer {
        Some(s) => {
            let seeds = s.seeds();
            let signer_seeds: &[&[&[u8]]] = &[&seeds];
            token::burn(
                CpiContext::new_with_signer(token_program.clone(), accs, signer_seeds),
                amount,
            )
        }
        None => token::burn(CpiContext::new(token_program.clone(), accs), amount),
    }
}

/// Emits `emit_cpi!`-compatible events while reusing one data buffer and one
/// account-meta list. Each `emit_cpi!` allocates fresh vectors, and the program heap
/// (32 KiB, bump allocator, never freed) runs out after a few dozen events; a taker
/// sweeping many makers emits one `Fill` per maker.
pub struct Emitter<'info> {
    ea: AccountInfo<'info>,
    bump: u8,
    buf: Vec<u8>,
    metas: Vec<AccountMeta>,
}

impl<'info> Emitter<'info> {
    pub fn new(event_authority: AccountInfo<'info>, bump: u8) -> Self {
        Self {
            ea: event_authority,
            bump,
            buf: Vec::with_capacity(320),
            metas: Vec::with_capacity(1),
        }
    }

    pub fn emit<E: anchor_lang::Event + anchor_lang::Discriminator>(
        &mut self,
        ev: &E,
    ) -> Result<()> {
        let mut data = core::mem::take(&mut self.buf);
        data.clear();
        data.extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE);
        data.extend_from_slice(E::DISCRIMINATOR);
        ev.serialize(&mut data)?;
        let mut metas = core::mem::take(&mut self.metas);
        metas.clear();
        metas.push(AccountMeta::new_readonly(*self.ea.key, true));
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: crate::ID,
            accounts: metas,
            data,
        };
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            core::slice::from_ref(&self.ea),
            &[&[b"__event_authority", &[self.bump]]],
        )?;
        self.buf = ix.data;
        self.metas = ix.accounts;
        Ok(())
    }
}
