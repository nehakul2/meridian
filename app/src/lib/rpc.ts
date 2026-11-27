/**
 * The few RPC calls the frontend makes itself (spec 3.1, C2: "RPC (send only)"): the network
 * check, the wallet's USDC balance (until the gateway's `md:bal` feed is wired, Phase 6
 * "Not wired yet"), sending a signed transaction and polling for its confirmation.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export type Confirmation = { status: "confirmed" } | { status: "failed"; error: string } | { status: "expired" };

export interface Rpc {
  genesisHash(): Promise<string>;
  /** Wallet USDC in micro-USDC (sum of the owner's token accounts for the mint). */
  usdcBalance(owner: string): Promise<string>;
  sendRaw(tx: Uint8Array): Promise<string>;
  confirm(signature: string, lastValidBlockHeight: number, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<Confirmation>;
}

export function createRpc(url: string, usdcMint: string): Rpc {
  const c = new Connection(url, { commitment: "confirmed" });
  return {
    genesisHash: () => c.getGenesisHash(),
    async usdcBalance(owner) {
      const r = await c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(usdcMint) });
      let total = 0n;
      for (const a of r.value) {
        const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
        if (amt) total += BigInt(amt);
      }
      return total.toString();
    },
    sendRaw: (tx) => c.sendRawTransaction(tx, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }),
    async confirm(signature, lastValidBlockHeight, opts = {}) {
      const interval = opts.intervalMs ?? 400;
      const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
      for (;;) {
        const { value } = await c.getSignatureStatuses([signature]);
        const s = value[0];
        if (s?.err) return { status: "failed", error: typeof s.err === "string" ? s.err : JSON.stringify(s.err) };
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { status: "confirmed" };
        if (Date.now() > deadline) return { status: "expired" };
        const h = await c.getBlockHeight("confirmed").catch(() => 0);
        if (h > lastValidBlockHeight) return { status: "expired" };
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };
}
