"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PhaseBanner } from "./Countdown";
import { SessionBanners, WalletButton } from "./WalletConnect";

const NAV = [
  { href: "/markets/", label: "Markets" },
  { href: "/portfolio/", label: "Portfolio" },
  { href: "/history/", label: "History" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Meridian home">
          <Logo />
          <span>Meridian</span>
          <span className="net-tag">devnet</span>
        </Link>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href.replace(/\/$/, "")) || (n.href === "/markets/" && path.startsWith("/trade")) ? "active" : ""}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <WalletButton />
        </div>
      </header>
      <SessionBanners />
      <PhaseBanner />
      <main className="main">{children}</main>
      <footer className="footer muted small">
        Meridian is a devnet prototype. Contracts pay $1.00 USDC to the winning side at the official close. Not investment advice.
      </footer>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 2v20" stroke="var(--accent)" strokeWidth="2" />
      <path d="M2 12h20" stroke="currentColor" strokeWidth="1" opacity=".4" />
    </svg>
  );
}
