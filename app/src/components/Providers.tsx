"use client";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useMemo, type ReactNode } from "react";
import { AuthProvider } from "@/lib/auth";
import { ServicesProvider } from "@/lib/services";
import { StatusProvider } from "@/lib/status";

/**
 * Wallets (MER-70): Phantom and Solflare adapters, plus every Wallet Standard wallet the
 * browser registers (Backpack, and the e2e test wallet) which the adapter picks up itself.
 */
export function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ServicesProvider>
      <WalletProvider wallets={wallets} autoConnect>
        <StatusProvider>
          <AuthProvider>{children}</AuthProvider>
        </StatusProvider>
      </WalletProvider>
    </ServicesProvider>
  );
}
