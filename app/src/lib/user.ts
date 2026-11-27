"use client";
/** User-scoped data hooks. Each reloads on a new session, on gateway user events and after a confirmed transaction. */
import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { useChannel, useServices } from "./services";

export const TX_CONFIRMED = "meridian:tx-confirmed";
export const notifyTxConfirmed = () => window.dispatchEvent(new Event(TX_CONFIRMED));

export function useOnTxConfirmed(f: () => void) {
  const ref = useRef(f);
  ref.current = f;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener(TX_CONFIRMED, h);
    return () => window.removeEventListener(TX_CONFIRMED, h);
  }, []);
}

/** Wallet USDC (micro), from RPC, replaced by the gateway's `balance` pushes when they arrive. */
export function useUsdcBalance(): { micro: string | null; refresh(): void } {
  const { rpc } = useServices();
  const { publicKey, connected } = useWallet();
  const owner = connected && publicKey ? publicKey.toBase58() : null;
  const [micro, setMicro] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!owner) return;
    rpc.usdcBalance(owner).then(setMicro, () => undefined);
  }, [rpc, owner]);
  useEffect(() => {
    setMicro(null);
    refresh();
  }, [refresh]);
  useOnTxConfirmed(refresh);
  useChannel(owner ? "user" : null, (m) => {
    if (m.type === "balance" && typeof m.usdc === "string") setMicro(m.usdc);
  });
  return { micro: owner ? micro : null, refresh };
}

/**
 * Loads a user-scoped resource once a session exists (it never prompts by itself unless
 * `prompt` is set), and reloads it when the session or the user's positions change.
 */
export function useUserResource<T>(load: (token: ReturnType<typeof useAuth>["token"]) => Promise<T>, opts: { prompt?: boolean } = {}) {
  const auth = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const prompted = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!auth.owner || auth.status !== "signed_in") return;
    setLoading(true);
    try {
      setData(await loadRef.current(auth.token));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [auth.owner, auth.status, auth.token]);

  useEffect(() => {
    setData(null);
  }, [auth.owner]);

  useEffect(() => {
    void reload();
  }, [reload, auth.epoch]);

  // First user-scoped action on this page: ask for the SIWS signature once per owner.
  useEffect(() => {
    if (!opts.prompt || !auth.ready || !auth.owner || auth.status !== "signed_out" || prompted.current === auth.owner) return;
    prompted.current = auth.owner;
    void auth.ensureToken().catch(() => undefined);
  }, [opts.prompt, auth]);

  useChannel(auth.status === "signed_in" ? "user" : null, (m) => {
    if (m.type === "position" || m.type === "fill" || m.type === "order") void reload();
  });
  useOnTxConfirmed(() => void reload());

  return { data, error, loading, reload };
}
