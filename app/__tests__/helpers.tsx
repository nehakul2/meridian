/**
 * Test harness: real StatusProvider and AuthProvider, with fake REST/Tx Builder, gateway and
 * RPC behind the services context and a fake wallet in the wallet adapter's own context.
 */
import { WalletContext, type WalletContextState } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi, type Mocked } from "vitest";
import type { ApiClient } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import type { AppConfig } from "@/lib/config";
import type { Rpc } from "@/lib/rpc";
import { ServicesProvider, type Services } from "@/lib/services";
import { StatusProvider } from "@/lib/status";
import type { WsMessage, Realtime } from "@/lib/ws";
import * as fx from "./fixtures";

export const OWNER = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(9));

export const testConfig: AppConfig = {
  apiUrl: "http://api", txbUrl: "http://api", wsUrl: "ws://api/v1/ws", rpcUrl: "http://rpc",
  expectedGenesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", chain: "solana:devnet",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", explorerCluster: "devnet",
};

/**
 * A real unsigned v0 transaction (payer OWNER), as the Tx Builder returns it. Built once in
 * Node: web3.js's layout encoder rejects jsdom's typed arrays, so it is not built in the test.
 */
export const UNSIGNED_TX = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAupKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQABAQA=";
export const unsignedTx = () => UNSIGNED_TX;

export class FakeRealtime implements Realtime {
  subs = new Map<string, Set<(m: WsMessage) => void>>();
  snapshots: string[] = [];
  tokens: (string | null)[] = [];
  system = new Set<(m: WsMessage) => void>();
  subscribe(ch: string, h: (m: WsMessage) => void) {
    if (!this.subs.has(ch)) this.subs.set(ch, new Set());
    this.subs.get(ch)!.add(h);
    return () => this.subs.get(ch)?.delete(h);
  }
  snapshot(ch: string) {
    this.snapshots.push(ch);
  }
  auth(t: string | null) {
    this.tokens.push(t);
  }
  onSystem(h: (m: WsMessage) => void) {
    this.system.add(h);
    return () => this.system.delete(h);
  }
  close() {}
  emit(ch: string, m: Record<string, unknown>) {
    for (const h of this.subs.get(ch) ?? []) h({ channel: ch, ...m } as WsMessage);
  }
}

export function fakeApi(over: Partial<ApiClient> = {}): Mocked<ApiClient> {
  const base: ApiClient = {
    status: vi.fn(async () => ({ ...fx.status, receivedAt: Date.now(), rttMs: 0 })),
    tickers: vi.fn(async () => fx.tickers),
    markets: vi.fn(async () => fx.metaMarkets),
    market: vi.fn(async (id: string) => ({ ...(fx.metaMarkets.markets.find((m) => m.marketId === id) ?? fx.metaMarkets.markets[3]!) })),
    book: vi.fn(async () => fx.bookYes),
    trades: vi.fn(async () => ({ data: [] })),
    settlements: vi.fn(async () => fx.settlements),
    siwsNonce: vi.fn(async (owner: string) => ({ nonce: "ab".repeat(16), message: `localhost wants you to sign in with your Solana account:\n${owner}\n\nNonce: ${"ab".repeat(16)}\n`, expiresAt: "2026-11-25T19:17:03Z" })),
    siwsVerify: vi.fn(async () => ({ token: "jwt-1", expiresAt: "2026-11-25T19:27:03Z" })),
    positions: vi.fn(async () => ({ data: [] })),
    orders: vi.fn(async () => ({ data: [] })),
    history: vi.fn(async () => ({ data: [], nextBefore: null })),
    claimable: vi.fn(async () => ({ data: [], totals: { ledgerUsdc: "0", redeemable: "0" } })),
    prefs: vi.fn(async () => ({ defaultView: "YES" as const, slippageCents: 2 })),
    putPrefs: vi.fn(async (_t, p) => ({ defaultView: p.defaultView ?? "YES", slippageCents: p.slippageCents ?? 2 })),
    txTrade: vi.fn(async (r) => ({ transaction: unsignedTx(), lastValidBlockHeight: 1000, summary: { intent: r.intent, qty: r.qty, copy: `copy for ${r.intent}`, maxCost: "0", payoutIfWin: "0" }, warnings: [] })),
    txCancel: vi.fn(async () => ({ transaction: unsignedTx(), lastValidBlockHeight: 1000, summary: { copy: "Cancel" }, warnings: [] })),
    txWithdraw: vi.fn(async () => ({ transaction: unsignedTx(), lastValidBlockHeight: 1000, summary: { copy: "Withdraw" }, warnings: [] })),
    txRedeem: vi.fn(async () => ({ transaction: unsignedTx(), lastValidBlockHeight: 1000, summary: { copy: "Redeem" }, warnings: [] })),
  };
  return { ...base, ...over } as unknown as Mocked<ApiClient>;
}

export function fakeRpc(over: Partial<Rpc> = {}): Mocked<Rpc> {
  return {
    genesisHash: vi.fn(async () => testConfig.expectedGenesis),
    usdcBalance: vi.fn(async () => "1250500000"),
    sendRaw: vi.fn(async () => "5igSig"),
    confirm: vi.fn(async () => ({ status: "confirmed" as const })),
    ...over,
  } as unknown as Mocked<Rpc>;
}

export function fakeWallet(o: { kp?: Keypair | null; chains?: string[]; signMessage?: WalletContextState["signMessage"]; signTransaction?: WalletContextState["signTransaction"] } = {}): WalletContextState {
  const kp = o.kp === undefined ? OWNER : o.kp;
  const pk = kp ? kp.publicKey : null;
  return {
    autoConnect: false,
    wallets: [],
    wallet: kp
      ? ({ adapter: { name: "Test", icon: "", wallet: { accounts: [{ address: pk!.toBase58(), chains: o.chains ?? ["solana:devnet"] }] } }, readyState: "Installed" } as unknown as WalletContextState["wallet"])
      : null,
    publicKey: pk,
    connecting: false,
    connected: !!kp,
    disconnecting: false,
    select: vi.fn(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendTransaction: vi.fn(),
    // The signed result only needs serialize(): real signing is covered by the Playwright suite.
    signTransaction: o.signTransaction ?? (vi.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) })) as unknown as WalletContextState["signTransaction"]),
    signAllTransactions: undefined,
    signMessage: o.signMessage ?? vi.fn(async () => new Uint8Array(64).fill(1)),
    signIn: undefined,
  };
}

export interface Harness {
  api: ReturnType<typeof fakeApi>;
  rt: FakeRealtime;
  rpc: ReturnType<typeof fakeRpc>;
  wallet: WalletContextState;
}

export function setup(o: { api?: Partial<ApiClient>; rpc?: Partial<Rpc>; wallet?: WalletContextState } = {}): Harness & { services: Services } {
  const api = fakeApi(o.api);
  const rt = new FakeRealtime();
  const rpc = fakeRpc(o.rpc);
  const wallet = o.wallet ?? fakeWallet();
  return { api, rt, rpc, wallet, services: { api, rt, rpc, config: testConfig } };
}

export function Wrap({ h, wallet, children }: { h: { services: Services }; wallet: WalletContextState; children: ReactNode }) {
  return (
    <ServicesProvider value={h.services}>
      <WalletContext.Provider value={wallet}>
        <StatusProvider pollMs={60_000}>
          <AuthProvider>{children}</AuthProvider>
        </StatusProvider>
      </WalletContext.Provider>
    </ServicesProvider>
  );
}

export function renderWith(ui: ReactNode, o: Parameters<typeof setup>[0] = {}) {
  const h = setup(o);
  const r = render(<Wrap h={h} wallet={h.wallet}>{ui}</Wrap>);
  return {
    ...h,
    ...r,
    rerenderWallet: (w: WalletContextState) => r.rerender(<Wrap h={h} wallet={w}>{ui}</Wrap>),
  };
}
