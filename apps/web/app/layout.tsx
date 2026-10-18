import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Sentinel Mesh Dashboard",
  description: "Read-only dashboard for the Sentinel Mesh multi-agent Web3 intelligence and guarded-trading platform (paper phase).",
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
