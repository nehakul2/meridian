"use client";
/**
 * Protocol status (spec 7.1) and the server clock offset (R7.3). Polls `/v1/status` every
 * 30 s and on focus; `paused` / `unpaused` on the gateway's `sys` channel apply at once.
 * Also runs the devnet network guard (MER-70).
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { offsetFrom } from "./clock";
import { useChannel, useServices } from "./services";
import type { Status } from "./types";

export interface StatusState {
  status: Status | null;
  /** True once one `/v1/status` reading has set the clock offset. */
  synced: boolean;
  offsetMs: number;
  /** Server time now, in ms. */
  now(): number;
  refresh(): Promise<void>;
  network: { ok: boolean; reason: string | null };
}

const Ctx = createContext<StatusState | null>(null);

export function StatusProvider({ children, pollMs = 30_000 }: { children: ReactNode; pollMs?: number }) {
  const { api, rpc, config } = useServices();
  const { wallet, publicKey } = useWallet();
  const [status, setStatus] = useState<Status | null>(null);
  const [offsetMs, setOffset] = useState(0);
  const [rpcReason, setRpcReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setOffset(offsetFrom(s.serverTime, s.receivedAt, s.rttMs));
      setStatus(s);
    } catch {
      /* keep the last status; the banner shows it */
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, pollMs);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, pollMs]);

  // Re-read the phase right after the close so the banner and trade panel flip without waiting for a poll.
  useEffect(() => {
    if (!status?.closeTimeUnix) return;
    const wait = status.closeTimeUnix * 1000 - (Date.now() + offsetMs) + 1000;
    if (wait <= 0 || wait > 86_400_000) return;
    const t = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(t);
  }, [status?.closeTimeUnix, offsetMs, refresh]);

  useChannel("sys", (m) => {
    if (m.type === "paused" || m.type === "unpaused") setStatus((s) => (s ? { ...s, paused: m.type === "paused" } : s));
    if (m.type === "settlement_progress") void refresh();
  });

  // Network guard, part 1: the app's RPC must be devnet.
  useEffect(() => {
    if (!config.expectedGenesis) return;
    let live = true;
    rpc.genesisHash().then(
      (g) => live && setRpcReason(g === config.expectedGenesis ? null : "Meridian runs on Solana devnet only, and this app is connected to a different network."),
      () => live && setRpcReason(null),
    );
    return () => {
      live = false;
    };
  }, [rpc, config.expectedGenesis]);

  // Part 2: a Wallet Standard account that lists its chains must include devnet.
  const walletReason = useMemo(() => {
    if (!wallet || !publicKey) return null;
    const std = (wallet.adapter as unknown as { wallet?: { accounts?: { address: string; chains?: readonly string[] }[] } }).wallet;
    const acct = std?.accounts?.find((a) => a.address === publicKey.toBase58());
    const chains = acct?.chains ?? [];
    if (chains.length === 0 || chains.includes(config.chain)) return null;
    return `Your wallet is on ${chains.map((c) => c.replace("solana:", "")).join(", ")}. Switch it to Devnet to trade on Meridian.`;
  }, [wallet, publicKey, config.chain]);

  const value = useMemo<StatusState>(() => {
    const reason = rpcReason ?? walletReason;
    return { status, synced: status !== null, offsetMs, now: () => Date.now() + offsetMs, refresh, network: { ok: !reason, reason } };
  }, [status, offsetMs, refresh, rpcReason, walletReason]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStatus(): StatusState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStatus outside StatusProvider");
  return s;
}

/** Re-renders every `ms` and returns the server time now (read at render, so a new offset applies at once). */
export function useServerNow(ms = 1000): number {
  const { now } = useStatus();
  const [, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now();
}
