//! MER-30 · full-precision price vs strike comparison (spec 4.4).
//! Matrix: SET-03, SET-04, ORC-14 (the comparison half; record_close.rs has the
//! instruction half) and the random half of SET-11.
use core::cmp::Ordering;

use meridian::{
    constants::*, errors::MeridianError, invariants::payout, settlement::*, state::Outcome,
};

const STRIKE: u64 = 68_000; // $680.00

fn code(e: anchor_lang::error::Error) -> u32 {
    match e {
        anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
        other => panic!("unexpected {other:?}"),
    }
}
fn want(e: MeridianError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

#[test]
fn set_03_exactly_at_strike_resolves_yes() {
    for (price, expo) in [(68_000i64, -2), (68_000_000, -5), (68_000_000_000, -8)] {
        assert_eq!(compare(price, expo, STRIKE).unwrap(), Ordering::Equal);
        assert_eq!(
            outcome_for(price, expo, STRIKE).unwrap(),
            Outcome::Yes,
            "expo {expo}"
        );
    }
}

#[test]
fn set_04_at_strike_at_full_precision_across_exponents() {
    // Matrix rows: 68000000 e-5, 6800000000 e-7, 680 e0, 68000 e-2 are all exactly $680.
    for (price, expo) in [
        (68_000_000i64, -5),
        (6_800_000_000, -7),
        (680, 0),
        (68_000, -2),
    ] {
        assert_eq!(
            outcome_for(price, expo, STRIKE).unwrap(),
            Outcome::Yes,
            "{price}e{expo}"
        );
    }
    // One unit below -> NO; one unit above -> YES.
    for (price, expo) in [
        (67_999_999i64, -5),
        (6_799_999_999, -7),
        (67_999, -2),
        (67_999_999_999, -8),
    ] {
        assert_eq!(
            outcome_for(price, expo, STRIKE).unwrap(),
            Outcome::No,
            "{price}e{expo}"
        );
    }
    for (price, expo) in [(68_000_001i64, -5), (68_001, -2), (681, 0)] {
        assert_eq!(
            outcome_for(price, expo, STRIKE).unwrap(),
            Outcome::Yes,
            "{price}e{expo}"
        );
    }
    // Positive exponent: 7 x 10^2 = $700 >= $680; 6 x 10^2 = $600 < $680.
    assert_eq!(outcome_for(7, 2, STRIKE).unwrap(), Outcome::Yes);
    assert_eq!(outcome_for(6, 2, STRIKE).unwrap(), Outcome::No);
    // Exponent -1 scales the strike, not the price: 6800 e-1 = $680.0.
    assert_eq!(compare(6_800, -1, STRIKE).unwrap(), Ordering::Equal);
    assert_eq!(compare(6_799, -1, STRIKE).unwrap(), Ordering::Less);
}

#[test]
fn set_04_extremes_do_not_overflow() {
    for expo in [MIN_EXPO, -8, -5, -2, 0, MAX_EXPO] {
        assert_eq!(compare(i64::MAX, expo, 1).unwrap(), Ordering::Greater);
        assert!(compare(1, expo, u64::MAX).is_ok());
        assert!(straddles(i64::MAX, expo, u64::MAX, u64::MAX).is_ok());
    }
    assert_eq!(
        code(compare(1, MIN_EXPO - 1, STRIKE).unwrap_err()),
        want(MeridianError::InvalidExpo)
    );
    assert_eq!(
        code(compare(1, MAX_EXPO + 1, STRIKE).unwrap_err()),
        want(MeridianError::InvalidExpo)
    );
}

#[test]
fn orc_14_negative_or_zero_price_rejected() {
    for p in [0i64, -1, i64::MIN] {
        assert_eq!(
            code(compare(p, -5, STRIKE).unwrap_err()),
            want(MeridianError::InvalidOraclePrice)
        );
        assert!(outcome_for(p, -5, STRIKE).is_err());
    }
}

#[test]
fn straddle_and_tolerance_boundaries() {
    // SET-06 numbers: 680.20 with conf 0.30 straddles 680 but not 700.
    assert!(straddles(68_020_000, -5, 30_000, 68_000).unwrap());
    assert!(!straddles(68_020_000, -5, 30_000, 70_000).unwrap());
    // |price - strike| == conf settles (the band must strictly contain the strike).
    assert!(!straddles(68_030_000, -5, 30_000, 68_000).unwrap());
    assert!(straddles(68_029_999, -5, 30_000, 68_000).unwrap());
    // conf 0 at the strike: no straddle (SET-03).
    assert!(!straddles(68_000_000, -5, 0, 68_000).unwrap());
    // conf / price <= max_bps, exact at the threshold (ORC-05, ORC-06).
    assert!(conf_within(68_000_000, 68_000, 10));
    assert!(!conf_within(68_000_000, 68_001, 10));
    // ORC-15 / ORC-16 numbers.
    assert!(within_tolerance(68_512_000, 68_498_000, 20_549, 20));
    assert!(!within_tolerance(69_000_000, 68_498_000, 20_549, 20));
    // Either side of the tolerance: conf wins when wider than bps.
    assert!(within_tolerance(
        68_000_000 + 200_000,
        68_000_000,
        200_000,
        20
    ));
}

/// splitmix64, as in invariants_prop.rs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

#[test]
fn set_11_random_prices_pay_exactly_one_dollar_per_pair() {
    let mut rng = Rng(0x5_E711);
    for i in 0..10_000 {
        let expo = -((rng.next() % 11) as i32); // 0 .. -10
        let price = (rng.next() % 2_000_000_000_000) as i64 + 1;
        let strike = rng.next() % 200_000 + 1;
        let o = outcome_for(price, expo, strike).unwrap();
        let (y, n) = payout(o);
        assert_eq!(y + n, MICRO_USDC_PER_PAIR, "case {i}");
        assert!((y == 0) ^ (n == 0), "never both, never neither: case {i}");
        // Cross-check against a decimal-string comparison (no shared code with compare).
        let p = price as u128;
        let (lhs, rhs) = if expo <= -2 {
            (p, strike as u128 * 10u128.pow((-2 - expo) as u32))
        } else {
            (p * 10u128.pow((expo + 2) as u32), strike as u128)
        };
        assert_eq!(
            o == Outcome::Yes,
            lhs >= rhs,
            "case {i}: {price}e{expo} vs {strike}"
        );
    }
}
