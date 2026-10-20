"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/traces", label: "Traces" },
  { href: "/tokens", label: "Tokens" },
  { href: "/risk", label: "Risk" },
  { href: "/whales", label: "Whales" },
  { href: "/signals", label: "Signals" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/journal", label: "Journal" },
  { href: "/fees", label: "Fees" },
  { href: "/skills", label: "Skills" },
  { href: "/payments", label: "Payments" },
  { href: "/ecosystem", label: "Ecosystem" },
  { href: "/execution", label: "Execution Safety" },
];

/**
 * Responsive navigation: horizontal bar on wide screens, disclosure menu on
 * mobile. The toggle is aria-expanded and the menu is hidden with [hidden],
 * so it is keyboard- and screen-reader-accessible.
 */
export function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const previouslyMobile = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 821px)");
    const sync = (): void => {
      if (mq.matches && previouslyMobile.current) {
        setOpen(false);
        previouslyMobile.current = false;
      }
      if (!mq.matches) previouslyMobile.current = true;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <header className="site-header">
      <div className="inner">
        <p className="brand">
          Sentinel Mesh <span className="phase">mainnet</span>
        </p>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close menu" : "Menu"}
        </button>
        <nav className="site-nav" id="primary-nav" aria-label="Primary" hidden={!open}>
          <ul>
            {NAV_ITEMS.map((item) => {
              const current = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={current ? "page" : undefined}>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <SiteNav />
      <main id="main" className="shell">
        {children}
      </main>
      <footer className="site-footer">
        <div className="shell" style={{ padding: 0 }}>
          <p style={{ margin: 0 }}>
            Sentinel Mesh dashboard · read-only · no keys, secrets, or signing logic in this frontend.
          </p>
          <ul>
            <li>Live data from the production orchestrator on Base and Solana mainnets.</li>
            <li>Paid API access settles per call in USDC via x402.</li>
          </ul>
        </div>
      </footer>
    </>
  );
}

export function PageHead({ title, lede, right }: { title: string; lede?: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {right}
    </div>
  );
}
