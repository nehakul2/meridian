/**
 * Sign and send a Tx Builder transaction (spec 7.4). The builder returns an unsigned v0
 * transaction with the blockhash set; the wallet signs it, we send it through our RPC and poll
 * until it is confirmed, failed or expired. Keys never leave the wallet.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { isRejection } from "./auth";
import type { Confirmation, Rpc } from "./rpc";
import type { TxResponse } from "./types";

export type TxPhase =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "signing" }
  | { kind: "pending"; signature: string }
  | { kind: "confirmed"; signature: string }
  | { kind: "failed"; message: string; signature?: string }
  | { kind: "rejected" };

export type SignTx = <T extends VersionedTransaction>(tx: T) => Promise<T>;
export type SignAllTx = <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>;

export function decodeTx(b64: string): VersionedTransaction {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return VersionedTransaction.deserialize(bytes);
}

export async function signSendConfirm(
  r: TxResponse,
  signTransaction: SignTx | undefined,
  rpc: Rpc,
  onPhase: (p: TxPhase) => void,
): Promise<TxPhase> {
  if (!signTransaction) {
    const p: TxPhase = { kind: "failed", message: "This wallet can't sign transactions." };
    onPhase(p);
    return p;
  }
  onPhase({ kind: "signing" });
  let signed: VersionedTransaction;
  try {
    signed = await signTransaction(decodeTx(r.transaction));
  } catch (e) {
    const p: TxPhase = isRejection(e) ? { kind: "rejected" } : { kind: "failed", message: (e as Error).message || "The wallet could not sign." };
    onPhase(p);
    return p;
  }
  let sig: string;
  try {
    sig = await rpc.sendRaw(signed.serialize());
  } catch (e) {
    const p: TxPhase = { kind: "failed", message: friendlySendError(e) };
    onPhase(p);
    return p;
  }
  onPhase({ kind: "pending", signature: sig });
  const c: Confirmation = await rpc.confirm(sig, r.lastValidBlockHeight);
  const p: TxPhase =
    c.status === "confirmed" ? { kind: "confirmed", signature: sig }
    : c.status === "expired" ? { kind: "failed", signature: sig, message: "The transaction expired before it landed. Nothing changed; try again." }
    : { kind: "failed", signature: sig, message: `The program rejected the transaction (${c.error}).` };
  onPhase(p);
  return p;
}

function friendlySendError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/blockhash not found/i.test(m)) return "The quote went stale before it was sent. Try again.";
  if (/insufficient/i.test(m)) return "Not enough SOL or USDC in the wallet for this transaction.";
  return `Sending failed: ${m.replace(/^failed to send transaction: /i, "")}`;
}
