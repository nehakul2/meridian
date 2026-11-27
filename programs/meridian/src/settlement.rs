//! Settlement math (MER-30, spec 4.4, 4.7, A30) and the Pyth `PriceUpdateV2` reader (A2).
//!
//! Everything here is integer math in `i128`: a price is `price x 10^expo` dollars, a
//! strike is `strike_cents x 10^-2`. Two numbers are compared by scaling both to the
//! smaller exponent, so nothing is ever rounded.
use core::cmp::Ordering;

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::state::Outcome;

/// Rejects zero or negative prices and exponents outside `[MIN_EXPO, MAX_EXPO]`.
pub fn check_price(price: i64, expo: i32) -> Result<()> {
    require!(price > 0, MeridianError::InvalidOraclePrice);
    require!(
        (MIN_EXPO..=MAX_EXPO).contains(&expo),
        MeridianError::InvalidExpo
    );
    Ok(())
}

fn pow10(n: u32) -> i128 {
    10i128.pow(n)
}

/// `price x 10^expo` and `strike_cents x 10^-2`, both as integers at one common exponent.
fn scaled(price: i64, expo: i32, strike_cents: u64) -> (i128, i128, i128) {
    let m = expo.min(STRIKE_EXPO);
    let ps = pow10((expo - m) as u32);
    let ss = pow10((STRIKE_EXPO - m) as u32);
    (price as i128 * ps, strike_cents as i128 * ss, ps)
}

/// Compares the price with the strike at full precision (spec 4.4).
pub fn compare(price: i64, expo: i32, strike_cents: u64) -> Result<Ordering> {
    check_price(price, expo)?;
    let (p, s, _) = scaled(price, expo, strike_cents);
    Ok(p.cmp(&s))
}

/// At or above the strike pays Yes (PRD "Settlement Logic", A31).
pub fn outcome_for(price: i64, expo: i32, strike_cents: u64) -> Result<Outcome> {
    Ok(match compare(price, expo, strike_cents)? {
        Ordering::Less => Outcome::No,
        _ => Outcome::Yes,
    })
}

/// True when the confidence band `[price - conf, price + conf]` straddles the strike,
/// i.e. `|price - strike| < conf` (A30, D27). `conf` uses the price's exponent.
pub fn straddles(price: i64, expo: i32, conf: u64, strike_cents: u64) -> Result<bool> {
    check_price(price, expo)?;
    let (p, s, ps) = scaled(price, expo, strike_cents);
    Ok((p - s).abs() < conf as i128 * ps)
}

/// `conf / price <= max_bps` (D27), exact: `conf x 10,000 <= price x max_bps`.
pub fn conf_within(price: i64, conf: u64, max_bps: u16) -> bool {
    price > 0 && (conf as i128) * 10_000 <= (price as i128) * (max_bps as i128)
}

/// Official close within `max(ref_conf, ref_price x tolerance_bps)` of the reference
/// (spec 4.7). Both prices use the same exponent.
pub fn within_tolerance(official: i64, ref_price: i64, ref_conf: u64, tolerance_bps: u16) -> bool {
    let diff = (official as i128 - ref_price as i128).abs();
    diff <= ref_conf as i128 || diff * 10_000 <= (ref_price as i128) * (tolerance_bps as i128)
}

/// The fields of a Pyth `PriceUpdateV2` that settlement reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceUpdate {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
}

/// Reads a Pyth Receiver `PriceUpdateV2` account (A2).
///
/// Checks: owned by the Pyth Receiver program (so the bytes were written by its Wormhole
/// verification and cannot be forged, SEC-02), the account discriminator, and
/// `verification_level == Full` (a partially verified update is rejected, ORC-08).
/// Read by hand rather than through the receiver SDK, which does not build on the
/// pinned platform-tools Cargo (README "Dependency pins"). Layout (Borsh):
/// `disc[8] write_authority[32] verification_level{Partial{u8}=0, Full=1}
/// feed_id[32] price:i64 conf:u64 exponent:i32 publish_time:i64 ...`.
pub fn read_price_update(info: &AccountInfo) -> Result<PriceUpdate> {
    require_keys_eq!(
        *info.owner,
        PYTH_RECEIVER_ID,
        MeridianError::InvalidOracleAccount
    );
    let data = info.try_borrow_data()?;
    parse_price_update(&data)
}

/// The pure part of `read_price_update` (no owner check).
pub fn parse_price_update(data: &[u8]) -> Result<PriceUpdate> {
    require!(
        data.len() >= 41 && data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        MeridianError::InvalidOracleAccount
    );
    // Tag 1 = Full. Tag 0 = Partial { num_signatures }, rejected whatever the count.
    require!(data[40] == 1, MeridianError::OracleNotFullyVerified);
    let m = &data[41..];
    require!(
        m.len() >= 32 + 8 + 8 + 4 + 8,
        MeridianError::InvalidOracleAccount
    );
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&m[..32]);
    let i64_at = |o: usize| i64::from_le_bytes(m[o..o + 8].try_into().unwrap());
    Ok(PriceUpdate {
        feed_id,
        price: i64_at(32),
        conf: u64::from_le_bytes(m[40..48].try_into().unwrap()),
        expo: i32::from_le_bytes(m[48..52].try_into().unwrap()),
        publish_time: i64_at(52),
    })
}
