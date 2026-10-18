"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../../../components/nav";
import { DataTable, DataSourceBadge, Timestamp, getJson, API_BASE, type Column } from "../../../../components/ui";

interface TokenDetail {
  dataSource: string;
  chain: string;
  token: { address: string; symbol?: string };
  metadata: { name: string; symbol: string; decimals: number };
  liquidity: Array<{ poolAddress: string; poolKind: string; quoteToken: string; tvlUsd: number; blockProvenance: { height: number; timestamp: string } }>;
  fees: { feeKind: string; feeUsd: number; details: string[] };
  provenance: { chainId: string; height: number; hash: string; timestamp: string };
}

interface EvidenceItemRow {
  evidenceId: string;
  kind: string;
  summary: string;
  sourceName: string;
  provenance: { chainId: string; retrievedVia: string };
  fetchedAt: string;
  limitations: string[];
}

export default function TokenEvidencePage(props: { params: Promise<{ chain: string; address: string }> }): React.JSX.Element {
  const { chain, address } = use(props.params);
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detailData, evidenceData] = await Promise.all([
        getJson<TokenDetail>(`${API_BASE}/api/v1/tokens/${chain}/${address}`),
        getJson<{ evidence: EvidenceItemRow[] }>(`${API_BASE}/api/v1/evidence?chain=${chain}&address=${address}`),
      ]);
      setDetail(detailData);
      setEvidence(evidenceData.evidence);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [chain, address]);

  useEffect(() => {
    void load();
  }, [load]);

  const liquidityColumns: Array<Column<TokenDetail["liquidity"][number]>> = [
    { key: "pool", header: "Pool", render: (row) => <code className="tiny">{row.poolAddress}</code> },
    { key: "kind", header: "Kind", render: (row) => <span className="badge">{row.poolKind}</span> },
    { key: "quote", header: "Quote token", render: (row) => <code className="tiny">{row.quoteToken}</code> },
    { key: "tvl", header: "TVL (USD, fixture)", render: (row) => `$${row.tvlUsd.toFixed(2)}` },
    { key: "height", header: "Block provenance", render: (row) => <span className="tiny">#{row.blockProvenance.height} · <Timestamp iso={row.blockProvenance.timestamp} /></span> },
  ];

  const evidenceColumns: Array<Column<EvidenceItemRow>> = [
    { key: "id", header: "Evidence ID", render: (row) => <code className="tiny">{row.evidenceId.slice(0, 16)}…</code> },
    { key: "kind", header: "Kind", render: (row) => <span className="badge tone-primary">{row.kind}</span> },
    { key: "summary", header: "Summary", render: (row) => row.summary },
    { key: "source", header: "Source", render: (row) => <span className="tiny">{row.sourceName} · {row.provenance.retrievedVia}</span> },
    { key: "fetched", header: "Fetched", render: (row) => <Timestamp iso={row.fetchedAt} /> },
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
        title={`Evidence: ${detail?.metadata.symbol ?? "token"}`}
        lede={`Chain ${chain} · ${address}. Metadata, pool liquidity, fee estimate, and schema-validated evidence items with their provenance and limitations. All values are deterministic fixture output.`}
        right={detail ? <DataSourceBadge source={detail.dataSource} /> : null}
      />
      {loading ? <div className="state" role="status">Loading token evidence…</div> : null}
      {error ? (
        <div className="state error" role="alert">
          <div className="state-title">Could not load this token</div>
          <p>{error}</p>
          <button type="button" className="btn retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {detail ? (
        <>
          <div className="grid">
            <div className="card">
              <h2>Contract metadata</h2>
              <p style={{ margin: "0.2rem 0" }}><strong>{detail.metadata.name}</strong> ({detail.metadata.symbol})</p>
              <p className="tiny muted" style={{ margin: 0 }}>decimals: {detail.metadata.decimals}</p>
            </div>
            <div className="card">
              <h2>Fee estimate</h2>
              <p style={{ margin: "0.2rem 0" }}><strong>${detail.fees.feeUsd.toFixed(2)}</strong> <span className="badge">{detail.fees.feeKind}</span></p>
              <p className="tiny muted" style={{ margin: 0 }}>{detail.fees.details.join(" · ")}</p>
            </div>
            <div className="card">
              <h2>Chain tip provenance</h2>
              <p style={{ margin: "0.2rem 0" }}>#{detail.provenance.height} · <code className="tiny">{detail.provenance.hash.slice(0, 18)}…</code></p>
              <p className="tiny muted" style={{ margin: 0 }}><Timestamp iso={detail.provenance.timestamp} /></p>
            </div>
          </div>

          <h2 style={{ fontSize: "1.05rem", margin: "1.4rem 0 0.4rem" }}>Pool liquidity (fixtures)</h2>
          <DataTable
            caption={`Liquidity observations for ${detail.metadata.symbol} on ${chain}`}
            columns={liquidityColumns}
            rows={detail.liquidity}
            rowKey={(row) => row.poolAddress}
            emptyTitle="No liquidity observations"
          />

          <h2 style={{ fontSize: "1.05rem", margin: "1.4rem 0 0.4rem" }}>Evidence items</h2>
          <DataTable
            caption={`Schema-validated evidence with provenance and limitations`}
            columns={evidenceColumns}
            rows={evidence}
            rowKey={(row) => row.evidenceId}
            emptyTitle="No evidence recorded for this token"
          />
        </>
      ) : null}
    </Shell>
  );
}
