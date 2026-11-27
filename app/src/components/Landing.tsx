"use client";
/** MER-71: landing page. What a contract is, live underlying prices, and the connect CTA. */
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { TickerGrid } from "./Markets";
import { WalletButton } from "./WalletConnect";

export function Landing() {
  const { connected } = useWallet();
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Daily binary contracts on Solana devnet</span>
          <h1>Will it close at or above the strike today?</h1>
          <p className="lead">
            Meridian lists Yes and No contracts on the Magnificent 7 every trading day. Each contract pays
            <strong> $1.00 USDC</strong> to the winning side at the official 4:00 PM ET close, and the price of Yes is the
            market's chance it happens.
          </p>
          <div className="hero-cta">
            {connected ? <Link className="btn btn-primary btn-lg" href="/markets/">Browse markets</Link> : <WalletButton />}
            <Link className="btn btn-ghost btn-lg" href="/markets/">See today's strikes</Link>
          </div>
        </div>
        <div className="hero-card card" aria-hidden="true">
          <div className="muted tiny">Example</div>
          <div className="hero-q">NVDA closes at or above $185.00</div>
          <div className="hero-split">
            <div className="hero-side yes"><span>Yes</span><strong>62¢</strong><em>pays $1.00 if at or above</em></div>
            <div className="hero-side no"><span>No</span><strong>38¢</strong><em>pays $1.00 if below</em></div>
          </div>
          <div className="prob-bar big"><span style={{ width: "62%" }} /></div>
          <div className="muted tiny">Yes + No always add up to $1.00, so one order book serves both sides.</div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Live underlying prices</h2><Link href="/markets/" className="small">All markets →</Link></div>
        <TickerGrid />
      </section>

      <section className="how">
        <div className="how-step card">
          <span className="how-n">1</span>
          <h3>Pick a strike</h3>
          <p className="muted">Strikes are set each morning around the stock's price and implied volatility, from deep in the money to far out.</p>
        </div>
        <div className="how-step card">
          <span className="how-n">2</span>
          <h3>Buy Yes or No</h3>
          <p className="muted">Pay the price in cents. Buying No at 38¢ is the same book as selling Yes at 62¢; Meridian does the conversion.</p>
        </div>
        <div className="how-step card">
          <span className="how-n">3</span>
          <h3>Settle at the close</h3>
          <p className="muted">After 4:00 PM ET the official closing price is recorded, checked against Pyth, and winners redeem for $1.00.</p>
        </div>
      </section>
    </div>
  );
}
