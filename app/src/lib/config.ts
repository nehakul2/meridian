/**
 * Build-time configuration (NEXT_PUBLIC_*). Defaults point at the local stub backend
 * (`npm run stub`), which serves the Phase 6 REST, Tx Builder, WebSocket and a minimal
 * JSON-RPC on one port.
 */
export interface AppConfig {
  apiUrl: string;
  txbUrl: string;
  wsUrl: string;
  rpcUrl: string;
  /** Genesis hash the RPC must report (devnet), or "" to skip the check (local validator). */
  expectedGenesis: string;
  /** Wallet Standard chain the wallet account must be on. */
  chain: string;
  usdcMint: string;
  explorerCluster: string;
}

const env = (v: string | undefined, d: string) => (v === undefined || v === "" ? d : v);

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const config: AppConfig = {
  apiUrl: env(process.env.NEXT_PUBLIC_API_URL, "http://localhost:8787"),
  txbUrl: env(process.env.NEXT_PUBLIC_TXB_URL, env(process.env.NEXT_PUBLIC_API_URL, "http://localhost:8787")),
  wsUrl: env(process.env.NEXT_PUBLIC_WS_URL, "ws://localhost:8787/v1/ws"),
  rpcUrl: env(process.env.NEXT_PUBLIC_RPC_URL, "http://localhost:8787/rpc"),
  expectedGenesis: env(process.env.NEXT_PUBLIC_EXPECTED_GENESIS, DEVNET_GENESIS),
  chain: env(process.env.NEXT_PUBLIC_CHAIN, "solana:devnet"),
  usdcMint: env(process.env.NEXT_PUBLIC_USDC_MINT, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  explorerCluster: env(process.env.NEXT_PUBLIC_EXPLORER_CLUSTER, "devnet"),
};

export function explorerTx(sig: string, cfg: AppConfig = config): string {
  const c = cfg.explorerCluster;
  const q = c.startsWith("http") ? `cluster=custom&customUrl=${encodeURIComponent(c)}` : `cluster=${c}`;
  return `https://explorer.solana.com/tx/${sig}?${q}`;
}
