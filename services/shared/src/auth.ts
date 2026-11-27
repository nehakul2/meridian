/**
 * Sign-In With Solana and the session JWT (spec 7.3, MER-61), dependency-free so the
 * API, the WS Gateway and the Tx Builder verify tokens the same way.
 *
 * - SIWS: the API issues a single-use nonce and the exact message to sign; the wallet
 *   signs the message bytes with ed25519; the API checks the signature against the
 *   owner pubkey and that the message is the one it issued.
 * - JWT: HS256, short-lived (default 15 min). `sub` = wallet pubkey; `adm` = true when
 *   the wallet was in the admin signer set at sign-in (re-checked on every admin call).
 */
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { b58decode } from "./base58.js";

export interface SiwsFields {
  domain: string;
  owner: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export function siwsMessage(f: SiwsFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.owner,
    "",
    "Sign in to Meridian. This request will not trigger a transaction or cost any fees.",
    "",
    `URI: https://${f.domain}`,
    "Version: 1",
    "Chain ID: solana",
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ].join("\n");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** ed25519 signature check. `signature` is base58 (wallet adapters) or base64. */
export function verifyEd25519(owner: string, message: string, signature: string): boolean {
  try {
    const pk = b58decode(owner);
    if (pk.length !== 32) return false;
    let sig: Uint8Array;
    try {
      sig = b58decode(signature);
    } catch {
      sig = Buffer.from(signature, "base64");
    }
    if (sig.length !== 64) sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pk)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  adm?: boolean;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(claims: JwtClaims, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export type JwtCheck = { ok: true; claims: JwtClaims } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function verifyJwt(token: string, secret: string, nowS: number): JwtCheck {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const [head, body, sig] = parts as [string, string, string];
  const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "BAD_SIGNATURE" };
  try {
    const h = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: string };
    if (h.alg !== "HS256") return { ok: false, reason: "MALFORMED" };
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JwtClaims;
    if (typeof c.sub !== "string" || typeof c.exp !== "number") return { ok: false, reason: "MALFORMED" };
    if (nowS >= c.exp) return { ok: false, reason: "EXPIRED" };
    return { ok: true, claims: c };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
}
