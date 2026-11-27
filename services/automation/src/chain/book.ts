/**
 * Read-only decoder for the zero-copy OrderBook account (programs/meridian/src/state.rs):
 * 8-byte discriminator, 152-byte header, then 198 levels (99 bid, 99 ask) of
 * `{ len: u8, _pad: [u8; 7], orders: [BookOrder; 8] }`, BookOrder = owner(32) order_id(8)
 * qty(8) tag(1) _pad(7). Used by the prune crank to pass owners' ledgers in book order.
 */
import { PublicKey } from "@solana/web3.js";

export const HEADER = 8 + 32 * 3 + 8 * 6 + 4 + 1 + 3;
export const ORDER_SIZE = 56;
export const LEVEL_CAPACITY = 8;
export const LEVEL_SIZE = 8 + ORDER_SIZE * LEVEL_CAPACITY;
export const PRICE_LEVELS = 99;
export const BOOK_LEN = HEADER + 2 * PRICE_LEVELS * LEVEL_SIZE;
export const TAG_BUY_NO = 1;

export interface RestingOrder {
  side: 0 | 1;
  price: number;
  owner: PublicKey;
  orderId: bigint;
  qty: bigint;
  tag: number;
}

export interface BookView {
  orderCount: number;
  /** Bids then asks, 1 to 99 cents, oldest first: the order prune_orders walks. */
  orders: RestingOrder[];
}

export function decodeBook(data: Uint8Array): BookView {
  if (data.length < BOOK_LEN) throw new Error(`order book too short: ${data.length} < ${BOOK_LEN}`);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  const orderCount = buf.readUInt32LE(8 + 96 + 48);
  const orders: RestingOrder[] = [];
  for (const side of [0, 1] as const) {
    for (let price = 1; price <= PRICE_LEVELS; price++) {
      const lvl = HEADER + (side * PRICE_LEVELS + price - 1) * LEVEL_SIZE;
      const len = buf.readUInt8(lvl);
      for (let i = 0; i < len; i++) {
        const o = lvl + 8 + i * ORDER_SIZE;
        orders.push({
          side,
          price,
          owner: new PublicKey(buf.subarray(o, o + 32)),
          orderId: buf.readBigUInt64LE(o + 32),
          qty: buf.readBigUInt64LE(o + 40),
          tag: buf.readUInt8(o + 48),
        });
      }
    }
  }
  return { orderCount, orders };
}
