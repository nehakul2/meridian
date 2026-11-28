/**
 * Devnet-only guard (MER-80, DLC-04). Every devnet script calls this before it signs anything.
 * Two checks, because a URL alone can lie (a custom RPC host can point at mainnet):
 *  1. the URL: any host naming mainnet is refused outright;
 *  2. the cluster's genesis hash: mainnet and testnet are refused, devnet is allowed, and an
 *     unknown genesis (a local validator) is allowed only on a loopback host.
 */
export const GENESIS = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;

export class MainnetRefused extends Error {
  constructor(reason: string) {
    super(`refusing to run: ${reason}. These scripts deploy and trade on devnet only (DLC-04).`);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** URL check only: throws for a mainnet-looking or unparsable URL. */
export function refuseMainnetUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MainnetRefused(`'${url}' is not a URL`);
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) throw new MainnetRefused(`unsupported scheme ${u.protocol}`);
  // Hosts like api.<mainnet>.solana.com, <mainnet>.helius-rpc.com, solana-<mainnet>.quiknode.pro.
  if (/main-?net/i.test(u.hostname) || /main-?net/i.test(u.pathname)) {
    throw new MainnetRefused(`RPC URL ${u.hostname} looks like mainnet`);
  }
}

export type ClusterKind = "devnet" | "local";

/** URL check, then the genesis hash the endpoint reports. Returns which cluster it is. */
export async function assertDevnet(url: string, getGenesisHash: () => Promise<string>): Promise<ClusterKind> {
  refuseMainnetUrl(url);
  const g = await getGenesisHash();
  if (g === GENESIS.mainnet) throw new MainnetRefused(`${new URL(url).hostname} serves mainnet (genesis ${g})`);
  if (g === GENESIS.testnet) throw new MainnetRefused(`${new URL(url).hostname} serves testnet, not devnet`);
  if (g === GENESIS.devnet) return "devnet";
  if (isLoopback(url)) return "local";
  throw new MainnetRefused(`unknown cluster (genesis ${g}) on a non-local host`);
}
