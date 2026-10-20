import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Sentinel Mesh Dashboard",
  description: "Read-only dashboard for the Sentinel Mesh multi-agent Web3 intelligence platform — live on Base and Solana mainnets, paid API access per call in USDC via x402.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
