"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { ChainFilter, DataTable, DataSourceBadge, getJson, API_BASE, type Column } from "../../components/ui";

interface FeeRow {
  chain: string;
  feeKind: string;
  feeUsd: number;
  confidence: number;
  details: string[];
  limitations: string[];
}

export default function FeesPage(): React.JSX.Element {
  const [chain, setChain] = useState("base");
  const [rows, setRows] = useState<FeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("fixture");

  const load = useCallback(async (selected: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ dataSource: string; analysis: FeeRow }>(`${API_BASE}/api/v1/fees?chain=${selected}`);
      setRows([data.analysis]);
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

  const columns: Array<Column<FeeRow>> = [
    { key: "chain", header: "Chain", render: (row) => <code>{row.chain}</code> },
    { key: "kind", header: "Fee kind", render: (row) => <span className="badge tone-primary">{row.feeKind}</span> },
    { key: "usd", header: "Estimate (USD, fixture)", render: (row) => <strong>${row.feeUsd.toFixed(2)}</strong> },
    { key: "confidence", header: "Confidence", render: (row) => <span className="tiny">{Math.round(row.confidence * 100)}%</span> },
    { key: "details", header: "Details", render: (row) => <p className="tiny" style={{ margin: 0 }}>{row.details.join("; ")}</p> },
    {
      key: "limitations",
      header: "Limitations",
      render: (row) => (
        <ul className="tiny muted" style={{ margin: 0, paddingLeft: "1rem" }}>
          {row.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ),
    },
  ];

  return (
    <Shell>
      <PageHead
        title="Fee estimator"
        lede="Advisory fee estimates from the fee-intelligence agent over fixture evidence. Estimates are advisory only — nothing executes, and estimates carry explicit limitations."
        right={<DataSourceBadge source={source} />}
      />
      <ChainFilter value={chain} onChange={setChain} />
      <DataTable
        caption={`Fee analysis for ${chain} (deterministic fixture)`}
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.chain}-${row.feeKind}`}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load(chain) } : undefined}
        emptyTitle="No fee estimate available"
        emptyDetail="The fee agent needs evidence items for this chain."
      />
    </Shell>
  );
}
