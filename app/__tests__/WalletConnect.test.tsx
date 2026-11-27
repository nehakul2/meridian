/** MER-70 · FE-01, FE-03: wallet connect, USDC balance, SIWS session, devnet guard. */
import { WalletSignMessageError } from "@solana/wallet-adapter-base";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SessionBanners, WalletButton } from "@/components/WalletConnect";
import { fakeWallet, OTHER, OWNER, renderWith } from "./helpers";

function Probe() {
  const a = useAuth();
  return (
    <div>
      <span data-testid="auth">{a.status}</span>
      <span data-testid="owner">{a.owner ?? "none"}</span>
      <button onClick={() => void a.ensureToken().catch(() => undefined)}>user action</button>
    </div>
  );
}

const ui = (
  <>
    <WalletButton />
    <SessionBanners />
    <Probe />
  </>
);

describe("WalletConnect (MER-70)", () => {
  it("shows the address and USDC balance after connect (FE-01)", async () => {
    const h = renderWith(ui);
    const addr = OWNER.publicKey.toBase58();
    expect(await screen.findByText(`${addr.slice(0, 4)}…${addr.slice(-4)}`)).toBeTruthy();
    expect(await screen.findByText("$1,250.50 USDC")).toBeTruthy();
    expect(h.rpc.usdcBalance).toHaveBeenCalledWith(addr);
  });

  it("does not ask for a signature on connect, only on the first user-scoped action", async () => {
    const h = renderWith(ui);
    await screen.findByText("$1,250.50 USDC");
    expect(h.wallet.signMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("user action"));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_in"));
    expect(h.api.siwsNonce).toHaveBeenCalledWith(OWNER.publicKey.toBase58());
    expect(h.api.siwsVerify).toHaveBeenCalledTimes(1);
    expect(h.rt.tokens.at(-1)).toBe("jwt-1");
  });

  it("disconnect clears user state", async () => {
    const h = renderWith(ui);
    fireEvent.click(screen.getByText("user action"));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_in"));
    h.rerenderWallet(fakeWallet({ kp: null }));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_out"));
    expect(screen.getByTestId("owner").textContent).toBe("none");
    expect(screen.getByTestId("connect-wallet")).toBeTruthy();
    expect(screen.queryByTestId("usdc-balance")).toBeNull();
    expect(h.rt.tokens.at(-1)).toBeNull();
  });

  it("an account switch signs in again as the new account", async () => {
    const h = renderWith(ui);
    fireEvent.click(screen.getByText("user action"));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_in"));
    h.api.siwsVerify.mockResolvedValueOnce({ token: "jwt-2", expiresAt: "2026-11-25T19:27:03Z" });
    h.rerenderWallet(fakeWallet({ kp: OTHER }));
    await waitFor(() => expect(h.api.siwsNonce).toHaveBeenLastCalledWith(OTHER.publicKey.toBase58()));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_in"));
    expect(screen.getByTestId("owner").textContent).toBe(OTHER.publicKey.toBase58());
    expect(h.rt.tokens.at(-1)).toBe("jwt-2");
  });

  it("a rejected SIWS signature shows a retry (FE-03)", async () => {
    const signMessage = vi.fn().mockRejectedValueOnce(new WalletSignMessageError("User rejected the request.")).mockResolvedValue(new Uint8Array(64).fill(2));
    const h = renderWith(ui, { wallet: fakeWallet({ signMessage }) });
    fireEvent.click(screen.getByText("user action"));
    const banner = await screen.findByTestId("siws-error");
    expect(banner.textContent).toContain("You declined the sign-in request");
    expect(screen.getByTestId("auth").textContent).toBe("rejected");
    expect(h.api.siwsVerify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("auth").textContent).toBe("signed_in"));
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("siws-error")).toBeNull();
  });

  it("warns when the RPC is not devnet", async () => {
    renderWith(ui, { rpc: { genesisHash: vi.fn(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") } });
    expect((await screen.findByTestId("network-warning")).textContent).toContain("devnet only");
  });

  it("warns when the wallet account is on another chain", async () => {
    renderWith(ui, { wallet: fakeWallet({ chains: ["solana:mainnet"] }) });
    expect((await screen.findByTestId("network-warning")).textContent).toContain("Switch it to Devnet");
  });

  it("no warning on devnet", async () => {
    const h = renderWith(ui);
    await waitFor(() => expect(h.rpc.genesisHash).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("network-warning")).toBeNull();
  });
});

describe("JWT refresh (MER-70)", () => {
  it("a 401 on a user route gets a fresh token once and retries", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      calls.push(auth);
      if (auth === "Bearer old") return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired", details: {} } }), { status: 401 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const api = createApi("http://api", "http://api", f as unknown as typeof fetch);
    let current = "old";
    const token = Object.assign(async () => current, { invalidate: vi.fn(() => { current = "new"; }) });
    const r = await api.positions(token);
    expect(r.data).toEqual([]);
    expect(calls).toEqual(["Bearer old", "Bearer new"]);
    expect(token.invalidate).toHaveBeenCalledTimes(1);
  });

  it("errors carry the spec envelope's code, message and details", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: "POSITION_CONFLICT", message: "Sell your No first", details: { requiredAction: "SELL_NO" } } }), { status: 409 }));
    const api = createApi("http://api", "http://api", f as unknown as typeof fetch);
    await expect(api.txTrade({ owner: "o", marketId: "m", intent: "BUY_YES", orderType: "MARKET", qty: 1, priceCents: 50 })).rejects.toMatchObject({
      code: "POSITION_CONFLICT", status: 409, message: "Sell your No first", details: { requiredAction: "SELL_NO" },
    });
  });
});
