/**
 * A Wallet Standard wallet for Playwright. The browser side registers "Meridian Test Wallet"
 * (the wallet adapter picks it up like Backpack or Phantom); signing happens in Node with real
 * ed25519 keys through exposed functions, so the stub backend verifies genuine signatures.
 *
 * Test hooks on window: __tw.reject = { message, tx } makes the next requests fail as a user
 * rejection (code 4001); __tw.switchTo(i) changes the active account (standard:events change).
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";

export const testKeypair = (i: number) => Keypair.fromSeed(createHash("sha256").update(`meridian-e2e-wallet-${i}`).digest());

export interface TestWalletOptions {
  accounts?: number[];
  chains?: string[];
}

export async function installTestWallet(page: Page, o: TestWalletOptions = {}) {
  const kps = (o.accounts ?? [0, 1]).map(testKeypair);
  const byAddr = new Map(kps.map((k) => [k.publicKey.toBase58(), k]));
  await page.exposeFunction("__twSignMessage", (addr: string, msg: number[]) => {
    const k = byAddr.get(addr)!;
    return Array.from(nacl.sign.detached(Uint8Array.from(msg), k.secretKey));
  });
  await page.exposeFunction("__twSignTx", (addr: string, bytes: number[]) => {
    const k = byAddr.get(addr)!;
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
    tx.sign([k]);
    return Array.from(tx.serialize());
  });
  const accounts = kps.map((k) => ({ address: k.publicKey.toBase58(), publicKey: Array.from(k.publicKey.toBytes()) }));
  // Plain JavaScript (not a serialized TS function: the TS runner's helpers do not exist in the page).
  await page.addInitScript({ content: `(${WALLET_JS})(${JSON.stringify({ accounts, chains: o.chains ?? ["solana:devnet"] })});` });
  return { keypairs: kps, address: (i = 0) => kps[i]!.publicKey.toBase58() };
}

const WALLET_JS = String.raw`function ({ accounts, chains }) {
  const w = window;
  const all = accounts.map((a) => ({ address: a.address, publicKey: Uint8Array.from(a.publicKey), chains, features: ["solana:signMessage", "solana:signTransaction"] }));
  let active = [];
  const listeners = new Set();
  const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
  w.__tw = {
    reject: { message: false, tx: false },
    requests: [],
    switchTo(i) {
      active = [all[i]];
      for (const l of listeners) l({ accounts: active });
    },
  };
  const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5b7cf0"/><path d="M9 22V10l7 7 7-7v12" stroke="#fff" stroke-width="3" fill="none"/></svg>');
  const wallet = {
    version: "1.0.0",
    name: "Meridian Test Wallet",
    icon,
    chains,
    get accounts() { return active; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { w.__tw.requests.push("connect"); if (active.length === 0) active = [all[0]]; return { accounts: active }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { active = []; } },
      "standard:events": { version: "1.0.0", on: (_e, l) => { listeners.add(l); return () => listeners.delete(l); } },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs) => {
          w.__tw.requests.push("signMessage");
          if (w.__tw.reject.message) throw rejected();
          return Promise.all(inputs.map(async ({ account, message }) => ({ signedMessage: message, signature: Uint8Array.from(await w.__twSignMessage(account.address, Array.from(message))) })));
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => {
          w.__tw.requests.push("signTransaction");
          if (w.__tw.reject.tx) throw rejected();
          return Promise.all(inputs.map(async ({ account, transaction }) => ({ signedTransaction: Uint8Array.from(await w.__twSignTx(account.address, Array.from(transaction))) })));
        },
      },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: cb })); } catch (e) {}
  window.addEventListener("wallet-standard:app-ready", (e) => cb(e.detail));
}`;
