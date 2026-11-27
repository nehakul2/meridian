"use client";
/** MER-70: connect / disconnect, address and USDC balance, SIWS state, devnet guard. */
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { shortAddr, usd } from "@/lib/format";
import { useStatus } from "@/lib/status";
import { useUsdcBalance } from "@/lib/user";

const SUGGESTED: { name: string; url: string }[] = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/download" },
];

export function WalletButton() {
  const { wallets, select, connected, connecting, publicKey, disconnect, wallet } = useWallet();
  const { micro } = useUsdcBalance();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

  if (connected && publicKey) {
    const addr = publicKey.toBase58();
    return (
      <div className="wallet" ref={menuRef}>
        <button className="wallet-pill" onClick={() => setMenu((m) => !m)} aria-label="Wallet menu" data-testid="wallet-pill">
          <span className="wallet-balance" data-testid="usdc-balance">{micro === null ? "…" : `${usd(micro)} USDC`}</span>
          <span className="wallet-addr" data-testid="wallet-address">
            {wallet?.adapter.icon ? <img src={wallet.adapter.icon} alt="" width={16} height={16} /> : null}
            {shortAddr(addr)}
          </span>
        </button>
        {menu ? (
          <div className="menu" role="menu">
            <div className="menu-head mono">{addr}</div>
            <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(addr); setMenu(false); }}>Copy address</button>
            <button role="menuitem" onClick={() => { setMenu(false); void disconnect(); }}>Disconnect</button>
          </div>
        ) : null}
      </div>
    );
  }

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const missing = SUGGESTED.filter((s) => !wallets.some((w) => w.adapter.name === s.name && (w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)));

  return (
    <>
      <button className="btn btn-primary" onClick={() => setPicker(true)} disabled={connecting} data-testid="connect-wallet">
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {picker ? (
        <div className="modal-backdrop" onClick={() => setPicker(false)}>
          <div className="modal" role="dialog" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Connect a wallet</h2>
              <button className="icon-btn" aria-label="Close" onClick={() => setPicker(false)}>×</button>
            </div>
            <p className="muted small">Meridian runs on Solana devnet. Your keys stay in your wallet; we only ask it to sign.</p>
            <ul className="wallet-list">
              {installed.map((w) => (
                <li key={w.adapter.name}>
                  <button onClick={() => { select(w.adapter.name as WalletName); setPicker(false); }}>
                    <img src={w.adapter.icon} alt="" width={28} height={28} />
                    <span>{w.adapter.name}</span>
                    <span className="tag">Detected</span>
                  </button>
                </li>
              ))}
              {missing.map((s) => (
                <li key={s.name}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    <span className="wallet-ph">{s.name[0]}</span>
                    <span>{s.name}</span>
                    <span className="tag tag-dim">Install</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Wrong network (MER-70) and the SIWS retry, shown under the header. */
export function SessionBanners() {
  const { network } = useStatus();
  const auth = useAuth();
  return (
    <>
      {!network.ok ? (
        <div className="banner banner-danger" role="alert" data-testid="network-warning">
          <strong>Wrong network.</strong> {network.reason}
        </div>
      ) : null}
      {auth.status === "rejected" || auth.status === "error" ? (
        <div className="banner banner-warn" role="alert" data-testid="siws-error">
          <span>{auth.error ?? "Sign-in failed."} Signing in lets Meridian show your positions; it costs nothing and sends no transaction.</span>
          <button className="btn btn-sm" onClick={() => void auth.ensureToken().catch(() => undefined)}>Try again</button>
        </div>
      ) : null}
    </>
  );
}
