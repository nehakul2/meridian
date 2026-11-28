//! Matching engine for the in-program order book (MER-20, D7, spec 4.1/4.2).
//!
//! Pure functions over `OrderBook` and a set of ledger balances, with no CPIs, so the
//! same code runs on-chain and in the unit tests below.
//!
//! Rules:
//! - Price-time priority. A taker bid walks asks from 1 cent up to its limit; a taker
//!   ask walks bids from 99 cents down to its limit. Within a level, oldest first.
//! - Fills happen at the maker's price.
//! - Self-trade: when the taker meets its own resting order, the resting order is
//!   cancelled (unlocked to the owner's ledger) and matching continues. A user never
//!   fills against themselves and never pays a fee to themselves.
//! - Makers are credited in their `UserLedger` (R4.6). The taker passes the makers'
//!   ledgers; matching stops at the first maker whose ledger is missing, so price-time
//!   priority is never skipped.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MeridianError;
use crate::state::*;

/// The ledger fields matching touches (a copy of `UserLedger` balances).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    pub free_usdc: u64,
    pub locked_usdc: u64,
    pub free_yes: u64,
    pub locked_yes: u64,
    pub open_order_count: u32,
    pub pending_buy_no: u64,
}

impl Balances {
    pub fn of(l: &UserLedger) -> Self {
        Self {
            free_usdc: l.free_usdc,
            locked_usdc: l.locked_usdc,
            free_yes: l.free_yes,
            locked_yes: l.locked_yes,
            open_order_count: l.open_order_count,
            pending_buy_no: l.pending_buy_no,
        }
    }

    pub fn store(&self, l: &mut UserLedger) {
        l.free_usdc = self.free_usdc;
        l.locked_usdc = self.locked_usdc;
        l.free_yes = self.free_yes;
        l.locked_yes = self.locked_yes;
        l.open_order_count = self.open_order_count;
        l.pending_buy_no = self.pending_buy_no;
    }
}

/// Ledgers available to one instruction, looked up by owner.
pub trait LedgerSet {
    fn get(&mut self, owner: &Pubkey) -> Option<&mut Balances>;
}

/// A simple owner -> balances list (index 0 is usually the taker).
#[derive(Default)]
pub struct LedgerVec {
    pub owners: Vec<Pubkey>,
    pub bals: Vec<Balances>,
}

impl LedgerSet for LedgerVec {
    fn get(&mut self, owner: &Pubkey) -> Option<&mut Balances> {
        let i = self.owners.iter().position(|o| o == owner)?;
        self.bals.get_mut(i)
    }
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(MeridianError::Overflow))
}
/// Subtraction that can only fail if the book's own accounting is broken.
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))
}

/// `price` cents x `qty` contracts in micro-USDC.
pub fn notional(price: u8, qty: u64) -> Result<u64> {
    (price as u64)
        .checked_mul(MICRO_USDC_PER_CENT)
        .and_then(|x| x.checked_mul(qty))
        .ok_or_else(|| error!(MeridianError::Overflow))
}

/// Taker fee on one fill, rounded up (in the protocol's favour, MER-25).
pub fn taker_fee(notional: u64, fee_bps: u16) -> u64 {
    if fee_bps == 0 || notional == 0 {
        return 0;
    }
    let n = notional as u128 * fee_bps as u128;
    n.div_ceil(10_000) as u64
}

pub fn valid_price(p: u8) -> bool {
    (MIN_PRICE..=MAX_PRICE).contains(&p)
}

pub fn opposite(side: usize) -> usize {
    1 - side
}

fn idx(side: usize, price: u8) -> usize {
    side * PRICE_LEVELS + (price as usize - 1)
}

impl OrderBook {
    pub fn level(&self, side: usize, price: u8) -> &Level {
        &self.levels[idx(side, price)]
    }

    fn level_mut(&mut self, side: usize, price: u8) -> &mut Level {
        &mut self.levels[idx(side, price)]
    }

    /// Best bid (highest) or best ask (lowest) price with resting orders.
    pub fn best(&self, side: usize) -> Option<u8> {
        if side == SIDE_BID {
            (MIN_PRICE..=MAX_PRICE)
                .rev()
                .find(|p| self.level(side, *p).len > 0)
        } else {
            (MIN_PRICE..=MAX_PRICE).find(|p| self.level(side, *p).len > 0)
        }
    }

    /// True if an order of `side` at `price` would trade against the opposite side.
    pub fn crosses(&self, side: usize, price: u8) -> bool {
        match self.best(opposite(side)) {
            None => false,
            Some(b) if side == SIDE_BID => b <= price,
            Some(b) => b >= price,
        }
    }

    /// Appends at the back of the level (time priority). Never overwrites.
    pub fn insert(&mut self, side: usize, price: u8, order: BookOrder) -> Result<()> {
        let lvl = self.level_mut(side, price);
        let n = lvl.len as usize;
        require!(n < LEVEL_CAPACITY, MeridianError::LevelFull);
        lvl.orders[n] = order;
        lvl.len += 1;
        self.order_count = self
            .order_count
            .checked_add(1)
            .ok_or(MeridianError::Overflow)?;
        Ok(())
    }

    pub fn remove_at(&mut self, side: usize, price: u8, i: usize) -> BookOrder {
        let lvl = self.level_mut(side, price);
        let n = lvl.len as usize;
        let o = lvl.orders[i];
        for j in i..n - 1 {
            lvl.orders[j] = lvl.orders[j + 1];
        }
        lvl.orders[n - 1] = BookOrder::default();
        lvl.len -= 1;
        self.order_count -= 1;
        o
    }

    /// Finds an order anywhere in the book.
    pub fn find(&self, order_id: u64) -> Option<(usize, u8, usize)> {
        for side in [SIDE_BID, SIDE_ASK] {
            for price in MIN_PRICE..=MAX_PRICE {
                let lvl = self.level(side, price);
                for i in 0..lvl.len as usize {
                    if lvl.orders[i].order_id == order_id {
                        return Some((side, price, i));
                    }
                }
            }
        }
        None
    }

    /// Every resting order of `owner`, as (side, price, order_id).
    pub fn orders_of(&self, owner: &Pubkey) -> Vec<(usize, u8, u64)> {
        let mut out = vec![];
        for side in [SIDE_BID, SIDE_ASK] {
            for price in MIN_PRICE..=MAX_PRICE {
                let lvl = self.level(side, price);
                for o in &lvl.orders[..lvl.len as usize] {
                    if o.owner == *owner {
                        out.push((side, price, o.order_id));
                    }
                }
            }
        }
        out
    }

    /// Removes an order and unlocks its remainder to the owner's free balances.
    /// The caller checks ownership. For a BUY_NO order the caller then merges.
    pub fn cancel(
        &mut self,
        order_id: u64,
        owner_bal: &mut Balances,
    ) -> Result<(usize, u8, BookOrder)> {
        let (side, price, i) = self.find(order_id).ok_or(MeridianError::OrderNotFound)?;
        let o = self.remove_at(side, price, i);
        self.unlock(side, price, &o, owner_bal)?;
        Ok((side, price, o))
    }

    pub fn unlock(
        &mut self,
        side: usize,
        price: u8,
        o: &BookOrder,
        b: &mut Balances,
    ) -> Result<()> {
        if side == SIDE_BID {
            let amt = notional(price, o.qty)?;
            b.locked_usdc = sub(b.locked_usdc, amt)?;
            b.free_usdc = add(b.free_usdc, amt)?;
            self.total_locked_usdc = sub(self.total_locked_usdc, amt)?;
            self.total_free_usdc = add(self.total_free_usdc, amt)?;
        } else {
            b.locked_yes = sub(b.locked_yes, o.qty)?;
            b.free_yes = add(b.free_yes, o.qty)?;
            self.total_locked_yes = sub(self.total_locked_yes, o.qty)?;
            self.total_free_yes = add(self.total_free_yes, o.qty)?;
            if o.tag == ORDER_TAG_BUY_NO {
                b.pending_buy_no = sub(b.pending_buy_no, o.qty)?;
            }
        }
        b.open_order_count = b
            .open_order_count
            .checked_sub(1)
            .ok_or(MeridianError::InvariantViolated)?;
        Ok(())
    }

    /// Rests an order and locks its escrow in the owner's ledger. The caller moves the
    /// tokens (USDC for a bid, Yes for an ask) into the book vault.
    pub fn rest(
        &mut self,
        side: usize,
        price: u8,
        order: BookOrder,
        b: &mut Balances,
    ) -> Result<()> {
        self.insert(side, price, order)?;
        if side == SIDE_BID {
            let amt = notional(price, order.qty)?;
            b.locked_usdc = add(b.locked_usdc, amt)?;
            self.total_locked_usdc = add(self.total_locked_usdc, amt)?;
        } else {
            b.locked_yes = add(b.locked_yes, order.qty)?;
            self.total_locked_yes = add(self.total_locked_yes, order.qty)?;
            if order.tag == ORDER_TAG_BUY_NO {
                b.pending_buy_no = add(b.pending_buy_no, order.qty)?;
            }
        }
        b.open_order_count = b
            .open_order_count
            .checked_add(1)
            .ok_or(MeridianError::Overflow)?;
        Ok(())
    }

    /// Moves free balances out of the book (withdraw, or a BUY_NO merge).
    pub fn take_free(&mut self, b: &mut Balances, usdc: u64, yes: u64) -> Result<()> {
        b.free_usdc = sub(b.free_usdc, usdc)?;
        b.free_yes = sub(b.free_yes, yes)?;
        self.total_free_usdc = sub(self.total_free_usdc, usdc)?;
        self.total_free_yes = sub(self.total_free_yes, yes)?;
        Ok(())
    }

    /// Credits USDC to an owner's free balance (a pruned BUY_NO conversion, MER-35).
    /// The caller moves the USDC into the quote vault.
    pub fn credit_free_usdc(&mut self, b: &mut Balances, usdc: u64) -> Result<()> {
        b.free_usdc = add(b.free_usdc, usdc)?;
        self.total_free_usdc = add(self.total_free_usdc, usdc)?;
        Ok(())
    }

    pub fn alloc_order_id(&mut self) -> Result<u64> {
        let id = self.next_order_id;
        self.next_order_id = add(id, 1)?;
        Ok(id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FillRec {
    pub maker_order_id: u64,
    pub maker: Pubkey,
    pub price: u8,
    pub qty: u64,
    pub notional: u64,
    pub fee: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelfCancel {
    pub side: usize,
    pub price: u8,
    pub order: BookOrder,
}

#[derive(Clone, Debug, Default)]
pub struct MatchOutcome {
    pub filled: u64,
    pub notional: u64,
    pub fees: u64,
    pub fills: Vec<FillRec>,
    pub self_cancels: Vec<SelfCancel>,
    /// Matching stopped because a crossing maker's ledger was not passed.
    pub stopped: bool,
    /// Matching stopped at MAX_FILLS_PER_IX with quantity left that could still cross.
    pub capped: bool,
}

/// Matches a taker order against the opposite side, up to `qty` at `limit` or better.
///
/// Book-side accounting only: maker ledgers and book totals are updated here. The
/// caller moves the taker's tokens:
/// - taker BID: pays `notional` (+ `fees`) USDC into the quote vault; receives (or merges)
///   `filled` Yes from the base vault.
/// - taker ASK: delivers `filled` Yes into the base vault; receives `notional` USDC
///   (- `fees`) from the quote vault.
pub fn match_taker<L: LedgerSet>(
    book: &mut OrderBook,
    taker: &Pubkey,
    taker_side: usize,
    limit: u8,
    qty: u64,
    fee_bps: u16,
    ledgers: &mut L,
) -> Result<MatchOutcome> {
    let maker_side = opposite(taker_side);
    let mut out = MatchOutcome {
        fills: Vec::with_capacity(24),
        ..Default::default()
    };
    let mut remaining = qty;
    let span = if taker_side == SIDE_BID {
        (limit - MIN_PRICE) as usize
    } else {
        (MAX_PRICE - limit) as usize
    };
    'levels: for step in 0..=span {
        let price = if taker_side == SIDE_BID {
            MIN_PRICE + step as u8
        } else {
            MAX_PRICE - step as u8
        };
        while remaining > 0 && book.level(maker_side, price).len > 0 {
            if out.fills.len() + out.self_cancels.len() >= MAX_FILLS_PER_IX {
                out.stopped = true;
                out.capped = true;
                break 'levels;
            }
            let front = book.level(maker_side, price).orders[0];
            if front.owner == *taker {
                let o = book.remove_at(maker_side, price, 0);
                let b = ledgers
                    .get(taker)
                    .ok_or(MeridianError::MakerLedgerMissing)?;
                book.unlock(maker_side, price, &o, b)?;
                out.self_cancels.push(SelfCancel {
                    side: maker_side,
                    price,
                    order: o,
                });
                continue;
            }
            let Some(mb) = ledgers.get(&front.owner) else {
                out.stopped = true;
                break 'levels;
            };
            let q = remaining.min(front.qty);
            let n = notional(price, q)?;
            if maker_side == SIDE_ASK {
                mb.locked_yes = sub(mb.locked_yes, q)?;
                mb.free_usdc = add(mb.free_usdc, n)?;
                if front.tag == ORDER_TAG_BUY_NO {
                    mb.pending_buy_no = sub(mb.pending_buy_no, q)?;
                }
                book.total_locked_yes = sub(book.total_locked_yes, q)?;
                book.total_free_usdc = add(book.total_free_usdc, n)?;
            } else {
                mb.locked_usdc = sub(mb.locked_usdc, n)?;
                mb.free_yes = add(mb.free_yes, q)?;
                book.total_locked_usdc = sub(book.total_locked_usdc, n)?;
                book.total_free_yes = add(book.total_free_yes, q)?;
            }
            let fee = taker_fee(n, fee_bps);
            out.fills.push(FillRec {
                maker_order_id: front.order_id,
                maker: front.owner,
                price,
                qty: q,
                notional: n,
                fee,
            });
            out.filled = add(out.filled, q)?;
            out.notional = add(out.notional, n)?;
            out.fees = add(out.fees, fee)?;
            remaining -= q;
            let left = front.qty - q;
            if left == 0 {
                book.remove_at(maker_side, price, 0);
                mb.open_order_count = mb
                    .open_order_count
                    .checked_sub(1)
                    .ok_or(MeridianError::InvariantViolated)?;
            } else {
                book.level_mut(maker_side, price).orders[0].qty = left;
            }
        }
        if remaining == 0 {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_book() -> Box<OrderBook> {
        // OrderBook is ~90 KB: build it on the heap.
        let zeroed: Box<[u8]> = vec![0u8; core::mem::size_of::<OrderBook>()].into_boxed_slice();
        let mut b: Box<OrderBook> =
            unsafe { Box::from_raw(Box::into_raw(zeroed) as *mut OrderBook) };
        b.next_order_id = 1;
        b
    }

    struct World {
        book: Box<OrderBook>,
        l: LedgerVec,
    }

    impl World {
        fn new(n: usize) -> (Self, Vec<Pubkey>) {
            let owners: Vec<Pubkey> = (0..n).map(|_| Pubkey::new_unique()).collect();
            (
                Self {
                    book: empty_book(),
                    l: LedgerVec {
                        owners: owners.clone(),
                        bals: vec![Balances::default(); n],
                    },
                },
                owners,
            )
        }
        fn rest(&mut self, owner: Pubkey, side: usize, price: u8, qty: u64) -> u64 {
            let id = self.book.alloc_order_id().unwrap();
            let o = BookOrder {
                owner,
                order_id: id,
                qty,
                tag: ORDER_TAG_NONE,
                _pad: [0; 7],
            };
            let b = self.l.get(&owner).unwrap();
            self.book.rest(side, price, o, b).unwrap();
            id
        }
    }

    #[test]
    fn price_then_time_priority() {
        let (mut w, u) = World::new(4);
        let bob_62 = w.rest(u[1], SIDE_ASK, 62, 10);
        let carol_60 = w.rest(u[2], SIDE_ASK, 60, 10);
        let dave_60 = w.rest(u[3], SIDE_ASK, 60, 10);
        let out = match_taker(&mut w.book, &u[0], SIDE_BID, 62, 25, 0, &mut w.l).unwrap();
        let seq: Vec<(u64, u8, u64)> = out
            .fills
            .iter()
            .map(|f| (f.maker_order_id, f.price, f.qty))
            .collect();
        assert_eq!(
            seq,
            vec![(carol_60, 60, 10), (dave_60, 60, 10), (bob_62, 62, 5)]
        );
        assert_eq!(out.notional, 20 * 600_000 + 5 * 620_000);
        assert_eq!(w.book.level(SIDE_ASK, 62).orders[0].qty, 5);
        assert_eq!(w.book.order_count, 1);
    }

    #[test]
    fn missing_ledger_stops_matching() {
        let (mut w, u) = World::new(3);
        w.rest(u[1], SIDE_ASK, 60, 10);
        w.rest(u[2], SIDE_ASK, 61, 10);
        let mut only_taker_and_carol = LedgerVec {
            owners: vec![u[0], u[2]],
            bals: vec![Balances::default(), *w.l.get(&u[2]).unwrap()],
        };
        let out = match_taker(
            &mut w.book,
            &u[0],
            SIDE_BID,
            61,
            15,
            0,
            &mut only_taker_and_carol,
        )
        .unwrap();
        assert!(out.stopped);
        assert_eq!(out.filled, 0, "never skips bob to reach carol");
    }

    #[test]
    fn level_capacity_is_enforced() {
        let (mut w, u) = World::new(1);
        for _ in 0..LEVEL_CAPACITY {
            w.rest(u[0], SIDE_BID, 40, 1);
        }
        let o = BookOrder {
            owner: u[0],
            order_id: 99,
            qty: 1,
            tag: 0,
            _pad: [0; 7],
        };
        let b = w.l.get(&u[0]).unwrap();
        assert!(w.book.rest(SIDE_BID, 40, o, b).is_err());
        assert_eq!(w.book.level(SIDE_BID, 40).len as usize, LEVEL_CAPACITY);
    }

    #[test]
    fn fee_rounds_up() {
        assert_eq!(taker_fee(600_000, 100), 6_000);
        assert_eq!(taker_fee(10_000, 1), 1);
        assert_eq!(taker_fee(10_001, 10_000), 10_001);
        assert_eq!(taker_fee(990_000, 0), 0);
        assert_eq!(taker_fee(1, 1), 1);
    }

    /// Random place / cancel / take sequences: book totals always equal the sum of the
    /// ledgers, and every resting order's remainder is covered by its owner's locks.
    #[test]
    fn totals_match_ledgers_under_random_sequences() {
        let mut seed = 0x1234_5678_9abc_def0u64;
        let mut rnd = |n: u64| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for _ in 0..200 {
            let (mut w, u) = World::new(4);
            for _ in 0..60 {
                let who = u[rnd(4) as usize];
                let side = rnd(2) as usize;
                let price = 1 + rnd(99) as u8;
                let qty = 1 + rnd(20);
                match rnd(3) {
                    0 => {
                        if !w.book.crosses(side, price)
                            && (w.book.level(side, price).len as usize) < LEVEL_CAPACITY
                        {
                            w.rest(who, side, price, qty);
                        }
                    }
                    1 => {
                        let mine = w.book.orders_of(&who);
                        if let Some((_, _, id)) = mine.first() {
                            let b = w.l.get(&who).unwrap();
                            w.book.cancel(*id, b).unwrap();
                        }
                    }
                    _ => {
                        let out =
                            match_taker(&mut w.book, &who, side, price, qty, 25, &mut w.l).unwrap();
                        assert!(out.filled <= qty);
                    }
                }
                let s = |f: fn(&Balances) -> u64| w.l.bals.iter().map(f).sum::<u64>();
                assert_eq!(w.book.total_locked_usdc, s(|b| b.locked_usdc));
                assert_eq!(w.book.total_free_usdc, s(|b| b.free_usdc));
                assert_eq!(w.book.total_locked_yes, s(|b| b.locked_yes));
                assert_eq!(w.book.total_free_yes, s(|b| b.free_yes));
                let mut rest_usdc = 0;
                let mut rest_yes = 0;
                let mut count = 0;
                for side in [SIDE_BID, SIDE_ASK] {
                    for p in MIN_PRICE..=MAX_PRICE {
                        let lvl = w.book.level(side, p);
                        for o in &lvl.orders[..lvl.len as usize] {
                            count += 1;
                            if side == SIDE_BID {
                                rest_usdc += notional(p, o.qty).unwrap();
                            } else {
                                rest_yes += o.qty;
                            }
                        }
                    }
                }
                assert_eq!(rest_usdc, w.book.total_locked_usdc);
                assert_eq!(rest_yes, w.book.total_locked_yes);
                assert_eq!(count, w.book.order_count);
                assert_eq!(
                    count,
                    w.l.bals.iter().map(|b| b.open_order_count).sum::<u32>()
                );
                // The book never rests crossed.
                if let (Some(b), Some(a)) = (w.book.best(SIDE_BID), w.book.best(SIDE_ASK)) {
                    assert!(b < a);
                }
            }
        }
    }
}
