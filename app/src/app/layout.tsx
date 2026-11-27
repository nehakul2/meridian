import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian",
  description: "Daily binary contracts on the Magnificent 7, settled at the official close. Solana devnet.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0f17" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
