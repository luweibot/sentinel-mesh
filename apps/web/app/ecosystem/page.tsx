import { Shell, PageHead } from "../../components/nav";
import { TOKEN } from "../../components/token-meta";
import Link from "next/link";

const PRODUCTS: Array<{
  name: string;
  status: "Live" | "Launching" | "Q1 2027" | "2027";
  badge: "ok" | "warn" | "primary" | "muted";
  blurb: string;
}> = [
  {
    name: "Sentinel Mesh API",
    status: "Live",
    badge: "ok",
    blurb:
      "Paid market intelligence for agents and traders: trending tokens, watched-wallet signals, guarded copy-trade execution. Paid per call via x402 (USDC) — no signup, no keys.",
  },
  {
    name: "$MESH Token",
    status: "Launching",
    badge: "primary",
    blurb:
      "100B fixed supply on Base, fair-launched through Bankr. Every trade funds the project: 0.95% of volume flows to development and auto-compounding liquidity.",
  },
  {
    name: "Sentinex Terminal",
    status: "Q1 2027",
    badge: "warn",
    blurb:
      "DeFAI agentic DEX + token trading terminal (Base + Solana): smart-money tracking, copy trading, sniping, limit orders, DCA, anti-MEV routing, PnL analytics — the full gmgn/basedbot feature set with x402-native agent commerce.",
  },
  {
    name: "Agent Marketplace",
    status: "2027",
    badge: "muted",
    blurb:
      "Third-party agents selling skills and data on Sentinel Mesh rails — x402 payments plus onchain agent identity (ERC-8004) for discovery and verification.",
  },
];

export default function EcosystemPage(): React.JSX.Element {
  return (
    <Shell>
      <PageHead
        title="Ecosystem"
        lede="Sentinel Mesh products, the $MESH token, and what ships next. Everything the project earns is published here."
      />

      <div className="card">
        <h2>What is Sentinel Mesh?</h2>
        <p>
          A multi-agent Web3 intelligence network for Base and Solana: it watches trending tokens and
          smart-money wallets around the clock, guards every copy trade with hard spend caps and a
          durable execution journal, and sells its market data to other agents and traders over the
          x402 HTTP payment protocol — pay per call in USDC, no signup.
        </p>
        <p>
          Base Builder Code <code>bc_fakbdw5t</code> attributes all onchain activity back to the
          project. Trading-fee revenue funds infrastructure first: the project is built to pay for
          itself.
        </p>
      </div>

      <div className="page-head" style={{ marginTop: "2rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>Products &amp; dApps</h2>
          <p className="lede">New dApps land on this page the day they ship.</p>
        </div>
      </div>
      <div className="grid">
        {PRODUCTS.map((p) => (
          <article key={p.name} className="card">
            <h3 style={{ margin: 0, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
              <span>{p.name}</span>
              <span className={`badge tone-${p.badge === "muted" ? "" : p.badge}`}>{p.status}</span>
            </h3>
            <p style={{ fontSize: "0.92rem" }}>{p.blurb}</p>
          </article>
        ))}
      </div>

      <div className="page-head" style={{ marginTop: "2rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>
            $MESH — the {TOKEN.symbol} token
          </h2>
          <p className="lede">Fair-launched on Base via Bankr. {TOKEN.supply} total supply, fixed forever.</p>
        </div>
      </div>
      <div className="grid">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Allocation</h3>
          <ul>
            {TOKEN.allocation.map((a) => (
              <li key={a.label}>
                <strong>{a.share}</strong> — {a.label}. <span style={{ color: "var(--muted)" }}>{a.detail}.</span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: "0.9rem" }}>
            Full token documentation:{" "}
            <Link href="/ecosystem/token">$MESH token docs</Link>.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Where the fees go</h3>
          <p style={{ fontSize: "0.92rem" }}>
            Every $MESH trade pays a 1.75% swap fee. <strong>0.95% of all volume</strong> flows to
            the project (0.665% direct fees + 0.285% auto-compounding locked liquidity). Fees are
            claimed weekly and published in the{" "}
            <Link href="/ecosystem/token#treasury">treasury report</Link>.
          </p>
          <p style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
            No transfer tax, no mint function, no admin keys over user funds.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h2>Developers</h2>
        <p style={{ fontSize: "0.92rem" }}>
          Build on Sentinel Mesh: the API is x402-native — your agent fetches{" "}
          <code>/api/v1/…</code>, receives <code>402 Payment Required</code>, signs an EIP-3009 USDC
          payment, and gets its data in the same request. See the{" "}
          <Link href="/payments">Payments page</Link> for the catalog, pricing, and the verify flow.
          Integrations and API partnerships: reach the team via the Bankr project page or X
          (@orebot_network).
        </p>
      </div>
    </Shell>
  );
}
