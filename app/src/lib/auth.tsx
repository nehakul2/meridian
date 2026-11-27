"use client";
/**
 * SIWS session (MER-70, spec 7.3). The JWT is fetched on the first user-scoped action, not on
 * connect: `ensureToken()` asks the wallet to sign the API's message once, and again only when
 * the token is within 30 s of expiry or the API answers 401. An account switch clears the
 * session and, if the user had one, signs in again as the new account.
 *
 * Expiry is compared on the server clock (the `/v1/status` offset), like the countdown, so a
 * client clock that is off by minutes neither keeps a dead token nor re-prompts in a loop.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TokenSource } from "./api";
import { useServices } from "./services";
import { useStatus } from "./status";

export type AuthStatus = "signed_out" | "signing" | "signed_in" | "rejected" | "error";

export interface Auth {
  owner: string | null;
  status: AuthStatus;
  /** The server clock is known, so stored tokens have been checked and prompting is safe. */
  ready: boolean;
  error: string | null;
  /** Bumps when the session changes (new owner or new token), so user data reloads. */
  epoch: number;
  ensureToken(): Promise<string>;
  /** For the API client: resolves a valid token and can be invalidated on a 401. */
  token: TokenSource & { invalidate(): void };
  signOut(): void;
}

const Ctx = createContext<Auth | null>(null);
const SKEW_S = 30;
const storeKey = (o: string) => `meridian.jwt.${o}`;

function load(owner: string): { token: string; exp: number } | null {
  try {
    const s = sessionStorage.getItem(storeKey(owner));
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function save(owner: string, v: { token: string; exp: number } | null) {
  try {
    if (v) sessionStorage.setItem(storeKey(owner), JSON.stringify(v));
    else sessionStorage.removeItem(storeKey(owner));
  } catch {
    /* private mode: session lives in memory only */
  }
}

export function isRejection(e: unknown): boolean {
  const x = e as { name?: string; message?: string; code?: number; error?: { code?: number } } | null;
  if (!x) return false;
  if (x.code === 4001 || x.error?.code === 4001) return true;
  return /reject|denied|cancel|declined/i.test(`${x.name ?? ""} ${x.message ?? ""}`);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { api, rt } = useServices();
  const { publicKey, signMessage, connected } = useWallet();
  const owner = connected && publicKey ? publicKey.toBase58() : null;
  const [status, setStatus] = useState<AuthStatus>("signed_out");
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const { offsetMs, synced } = useStatus();
  const offset = useRef(offsetMs);
  offset.current = offsetMs;
  const serverNowS = () => (Date.now() + offset.current) / 1000;
  const session = useRef<{ owner: string; token: string; exp: number; gotAt?: number } | null>(null);
  const inflight = useRef<Promise<string> | null>(null);
  const prevOwner = useRef<string | null>(null);
  const signRef = useRef(signMessage);
  signRef.current = signMessage;

  const signIn = useCallback(async (who: string): Promise<string> => {
    const sign = signRef.current;
    if (!sign) throw Object.assign(new Error("This wallet can't sign messages, so it can't sign in to Meridian."), { code: "NO_SIGN_MESSAGE" });
    setStatus("signing");
    setError(null);
    try {
      const { message } = await api.siwsNonce(who);
      const sig = await sign(new TextEncoder().encode(message));
      const r = await api.siwsVerify(who, bs58.encode(sig), message);
      const exp = Math.floor(Date.parse(r.expiresAt) / 1000);
      session.current = { owner: who, token: r.token, exp, gotAt: Date.now() };
      save(who, { token: r.token, exp });
      setStatus("signed_in");
      setEpoch((e) => e + 1);
      rt.auth(r.token);
      return r.token;
    } catch (e) {
      const rejected = isRejection(e);
      setStatus(rejected ? "rejected" : "error");
      setError(rejected ? "You declined the sign-in request in your wallet." : (e as Error).message);
      throw e;
    }
  }, [api, rt]);

  const ensureToken = useCallback(async (): Promise<string> => {
    if (!owner) throw Object.assign(new Error("Connect a wallet first"), { code: "NOT_CONNECTED" });
    const s = session.current;
    // A token minted in the last minute is fresh even if the clock offset is not known yet.
    if (s && s.owner === owner && (s.exp - SKEW_S > serverNowS() || Date.now() - (s.gotAt ?? 0) < 60_000)) return s.token;
    if (inflight.current) return inflight.current;
    const p = signIn(owner).finally(() => {
      inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [owner, signIn]);

  const invalidate = useCallback(() => {
    if (session.current) save(session.current.owner, null);
    session.current = null;
  }, []);

  // Connect, disconnect and account switch.
  useEffect(() => {
    const prev = prevOwner.current;
    prevOwner.current = owner;
    if (prev === owner) return;
    const hadSession = !!session.current && session.current.owner === prev;
    session.current = null;
    inflight.current = null;
    setError(null);
    if (!owner) {
      setStatus("signed_out");
      rt.auth(null);
      setEpoch((e) => e + 1);
      return;
    }
    const stored = load(owner);
    if (stored && stored.exp - SKEW_S > serverNowS()) {
      session.current = { owner, ...stored };
      setStatus("signed_in");
      rt.auth(stored.token);
      setEpoch((e) => e + 1);
      return;
    }
    setStatus("signed_out");
    rt.auth(null);
    setEpoch((e) => e + 1);
    // Account switch: the old JWT belongs to the old wallet; sign in again as the new one.
    if (prev && hadSession) void signIn(owner).catch(() => undefined);
  }, [owner, rt, signIn]);

  // A stored token is judged on the server clock, so check it again once the offset is known.
  useEffect(() => {
    if (!synced || !owner || session.current) return;
    const stored = load(owner);
    if (stored && stored.exp - SKEW_S > serverNowS()) {
      session.current = { owner, ...stored };
      setStatus("signed_in");
      rt.auth(stored.token);
      setEpoch((e) => e + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, owner, rt]);

  const token = useMemo(() => Object.assign(() => ensureToken(), { invalidate }), [ensureToken, invalidate]);

  const value = useMemo<Auth>(() => ({
    owner, status, ready: synced, error, epoch, ensureToken, token,
    signOut: () => {
      invalidate();
      setStatus("signed_out");
      rt.auth(null);
      setEpoch((e) => e + 1);
    },
  }), [owner, status, synced, error, epoch, ensureToken, token, invalidate, rt]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAuth outside AuthProvider");
  return a;
}
