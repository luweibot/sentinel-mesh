import { Shell, PageHead } from "../../../components/nav";
import { TOKEN } from "../../../components/token-meta";

export default function TokenDocsPage(): React.JSX.Element {
  const launched = TOKEN.address.length > 0;
  const basescan = launched ? `https://basescan.org/token/${TOKEN.address}` : null;
  const poolScan = launched ? `https://basescan.org/address/${TOKEN.poolAddress}` : null;
  return (
    <Shell>
      <PageHead
        title={`$${TOKEN.symbol} Token Docs`}
        lede={`${TOKEN.name} (${TOKEN.symbol}) — the Sentinel Mesh network token on ${TOKEN.chain}.`}
      />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Overview</h2>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr>
                <th scope="row">Token</th>
                <td>
                  {TOKEN.name} (<strong>${TOKEN.symbol}</strong>)
                </td>
              </tr>
              <tr>
                <th scope="row">Chain</th>
                <td>
                  {TOKEN.chain} (chain ID {TOKEN.chainId})
                </td>
              </tr>
              <tr>
                <th scope="row">Standard</th>
                <td>{TOKEN.standard}</td>
              </tr>
              <tr>
                <th scope="row">Total supply</th>
                <td>{TOKEN.supply}</td>
              </tr>
              <tr>
                <th scope="row">Launchpad</th>
                <td>{TOKEN.launchpad} — fair launch, Doppler</td>
              </tr>
              <tr>
                <th scope="row">Pool</th>
                <td>
                  {launched ? (
                    <a href={poolScan ?? "#"} rel="noreferrer noopener" target="_blank">
                      Uniswap V4 {TOKEN.symbol}/WETH
                    </a>
                  ) : (
                    "Uniswap V4 (MESH/WETH) — created at launch"
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Contract</th>
                <td>
                  {launched ? (
                    <a href={basescan ?? "#"} rel="noreferrer noopener" target="_blank" className="cell-mono">
                      {TOKEN.address}
                    </a>
                  ) : (
                    <span className="cell-muted">Published at launch — follow @orebot_network</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Transfer tax</th>
                <td>None. No mint function, no admin control over user funds.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Allocation &amp; vesting</h2>
        <div className="table-wrap">
          <table className="data">
            <caption>Fixed at launch. Supply is non-mintable.</caption>
            <thead>
              <tr>
                <th>Allocation</th>
                <th>Share</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {TOKEN.allocation.map((a) => (
                <tr key={a.label}>
                  <td>{a.label}</td>
                  <td className="nowrap">
                    <strong>{a.share}</strong>
                  </td>
                  <td className="cell-muted">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
          The creator allocation vests over one year with a 30-day cliff: nothing unlocks in the
          first 30 days, then it vests continuously. The vesting schedule is public onchain data.
        </p>
      </div>

      <div className="card">
        <h2>Fee schedule (per trade on the {TOKEN.symbol}/WETH pool)</h2>
        <div className="table-wrap">
          <table className="data">
            <caption>Total swap fee 1.75% of trading volume. Fixed at launch, never changes.</caption>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Share of volume</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {TOKEN.feeSchedule.map((f) => (
                <tr key={f.recipient}>
                  <td>{f.recipient}</td>
                  <td className="nowrap">
                    <strong>{f.share}</strong>
                  </td>
                  <td className="cell-muted">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: "0.9rem" }}>
          The project collects its fees in WETH only (quote-only fees), so the treasury grows in
          the pool&apos;s quote asset with zero sell pressure on $MESH. Creator fees are claimable
          at any time; the LP share compounds automatically as permanently locked liquidity — the
          $MESH liquidity floor grows with every trade.
        </p>
      </div>

      <div className="card">
        <h2>Utility</h2>
        <ul>
          {TOKEN.utility.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
        <p style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
          Utility grows with the ecosystem: each new dApp on the{" "}
          <a href="/ecosystem">Ecosystem page</a> adds a reason to hold and use $MESH.
        </p>
      </div>

      <div className="card" id="treasury">
        <h2>Treasury transparency</h2>
        <p style={{ fontSize: "0.92rem" }}>
          All creator fees flow to the project treasury and are used for infrastructure, security,
          and development — in that order. Claims and spend are published here on a rolling basis:
        </p>
        <div className="state">
          <p className="state-title">Treasury reporting starts after launch</p>
          <p>First fee claim and spend report will appear in this section.</p>
        </div>
      </div>

      <div className="card">
        <h2>Buying $MESH</h2>
        <p style={{ fontSize: "0.92rem" }}>
          Trade the {TOKEN.symbol}/WETH pool on Base through any Uniswap V4-compatible interface
          {launched ? " (contract linked above)" : ""}, or via the Bankr terminal at launch. Always
          verify the contract address against this page before trading. $MESH is a network utility
          token, not an investment contract; nothing here is financial advice.
        </p>
      </div>
    </Shell>
  );
}
