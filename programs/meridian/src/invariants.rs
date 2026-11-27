//! Market invariants (spec 4.3), asserted at the end of every mutating instruction (MER-14).
//!
//! Item 7 (book escrow) is added with the order book in MER-20; item 6
//! (status only moves forward) is enforced at each status write and checked
//! by the property tests.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::state::{Market, MarketStatus, Outcome};

/// Payout in micro-USDC for one token of each side, given an outcome.
/// Invariant 4: `payout(o).0 + payout(o).1 == $1.00` for every settled outcome.
pub fn payout(outcome: Outcome) -> (u64, u64) {
    match outcome {
        Outcome::Yes => (MICRO_USDC_PER_PAIR, 0),
        Outcome::No => (0, MICRO_USDC_PER_PAIR),
        Outcome::Void => (MICRO_USDC_VOID_PAYOUT, MICRO_USDC_VOID_PAYOUT),
        Outcome::None => (0, 0),
    }
}

/// The numbers the invariants are checked against, read after all CPIs.
#[derive(Clone, Copy, Debug)]
pub struct MarketSnapshot {
    pub status: MarketStatus,
    pub outcome: Outcome,
    pub pairs_outstanding: u64,
    pub collateral_accounted: u64,
    pub vault_amount: u64,
    pub yes_supply: u64,
    pub no_supply: u64,
}

impl MarketSnapshot {
    pub fn of(market: &Market, vault_amount: u64, yes_supply: u64, no_supply: u64) -> Self {
        Self {
            status: market.status,
            outcome: market.outcome,
            pairs_outstanding: market.pairs_outstanding,
            collateral_accounted: market.collateral_accounted,
            vault_amount,
            yes_supply,
            no_supply,
        }
    }
}

/// Returns the first violated invariant number, or `None` if all hold.
pub fn check(s: &MarketSnapshot) -> Option<u8> {
    // 1. vault >= accounted (D17: donations never brick the market).
    if s.vault_amount < s.collateral_accounted {
        return Some(1);
    }
    match s.status {
        MarketStatus::Trading | MarketStatus::Halted => {
            // 2. Pre-settlement: accounted == pairs * $1 and yes == no == pairs.
            let expected = s.pairs_outstanding.checked_mul(MICRO_USDC_PER_PAIR);
            if expected != Some(s.collateral_accounted)
                || s.yes_supply != s.pairs_outstanding
                || s.no_supply != s.pairs_outstanding
                || s.outcome != Outcome::None
            {
                return Some(2);
            }
        }
        MarketStatus::Settled | MarketStatus::Void => {
            // 3. Post-settlement: accounted == value of outstanding winning tokens.
            let (py, pn) = payout(s.outcome);
            if s.outcome == Outcome::None || py.checked_add(pn) != Some(MICRO_USDC_PER_PAIR) {
                return Some(4);
            }
            let owed = (s.yes_supply as u128) * (py as u128) + (s.no_supply as u128) * (pn as u128);
            if owed != s.collateral_accounted as u128 {
                return Some(3);
            }
        }
    }
    None
}

pub fn assert_invariants(s: &MarketSnapshot) -> Result<()> {
    if let Some(n) = check(s) {
        msg!("invariant {} violated: {:?}", n, s);
        return err!(MeridianError::InvariantViolated);
    }
    Ok(())
}
