"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { ChainFilter, DataTable, DataSourceBadge, Timestamp, getJson, API_BASE, type Column } from "../../components/ui";

interface WhaleEventRow {
  eventId: string;
  kind: string;
  wallet: string;
  counterparty: string;
  amountUsd?: number;
  blockNumber?: number;
  observedAt: string;
}

export default function WhalesPage(): React.JSX.Element {
  const [chain, setChain] = useState("base");
  const [events, setEvents] = useState<WhaleEventRow[]>([]);
  const [analysis, setAnalysis] = useState<{ summary: string; facts: string[]; findings: string[]; unknowns: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("fixture");

  const load = useCallback(async (selected: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ dataSource: string; events: WhaleEventRow[]; analysis: { summary: string; facts: string[]; findings: string[]; unknowns: string[] } }>(
        `${API_BASE}/api/v1/whales?chain=${selected}`,
      );
      setEvents(data.events);
      setAnalysis(data.analysis);
      setSource(data.dataSource);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(chain);
  }, [chain, load]);

  const columns: Array<Column<WhaleEventRow>> = [
    { key: "kind", header: "Kind", render: (row) => <span className="badge tone-primary">{row.kind}</span> },
    { key: "wallet", header: "Wallet", render: (row) => <code className="tiny">{row.wallet.slice(0, 12)}…</code> },
    { key: "counterparty", header: "Counterparty", render: (row) => <code className="tiny">{row.counterparty.slice(0, 12)}…</code> },
    { key: "amount", header: "Amount (USD, fixture)", render: (row) => (row.amountUsd !== undefined ? `$${row.amountUsd.toFixed(2)}` : "—") },
    { key: "block", header: "Block/slot", render: (row) => (row.blockNumber !== undefined ? `#${row.blockNumber}` : "—") },
    { key: "observed", header: "Observed", render: (row) => <Timestamp iso={row.observedAt} /> },
  ];

  return (
    <Shell>
      <PageHead
        title="Whale activity"
        lede="Large-wallet movements classified by the whale-tracking agent. Amounts and wallets are deterministic fixtures; the analysis separates observed facts from derived findings."
        right={<DataSourceBadge source={source} />}
      />
      <ChainFilter value={chain} onChange={setChain} />
      {analysis ? (
        <div className="card">
          <h2>Agent analysis</h2>
          <p style={{ margin: "0.2rem 0" }}>{analysis.summary}</p>
          <p className="tiny" style={{ margin: "0.2rem 0" }}><strong>Facts:</strong> {analysis.facts.join("; ")}</p>
          <p className="tiny" style={{ margin: "0.2rem 0" }}><strong>Findings:</strong> {analysis.findings.join("; ") || "—"}</p>
          <p className="tiny muted" style={{ margin: "0.2rem 0" }}><strong>Unknowns:</strong> {analysis.unknowns.join("; ") || "—"}</p>
        </div>
      ) : null}
      <DataTable
        caption={`Wallet activity events on ${chain} (fixtures)`}
        columns={columns}
        rows={events}
        rowKey={(row) => row.eventId}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load(chain) } : undefined}
        emptyTitle="No activity observed"
        emptyDetail="The fixture activity provider returned no events for this wallet."
      />
    </Shell>
  );
}
