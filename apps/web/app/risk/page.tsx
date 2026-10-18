"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { ChainFilter, DataTable, DataSourceBadge, getJson, API_BASE, type Column } from "../../components/ui";

interface RiskRow {
  token: { chainId: string; address: string; symbol?: string };
  risk: {
    riskLevel: string;
    facts: string[];
    findings: string[];
    unknowns: string[];
    limitations: string[];
  };
  generatedAt?: string;
}

export default function RiskPage(): React.JSX.Element {
  const [chain, setChain] = useState("base");
  const [rows, setRows] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("fixture");

  const load = useCallback(async (selected: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ dataSource: string; findings: RiskRow[] }>(`${API_BASE}/api/v1/risk?chain=${selected}`);
      setRows(data.findings);
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

  const columns: Array<Column<RiskRow>> = [
    {
      key: "token",
      header: "Token",
      render: (row) => (
        <>
          <strong>{row.token.symbol ?? "—"}</strong>
          <br />
          <code className="tiny">{row.token.address.slice(0, 14)}…</code>
        </>
      ),
    },
    {
      key: "level",
      header: "Risk level",
      render: (row) => (
        <span
          className={`badge ${
            row.risk.riskLevel === "low" ? "tone-ok" : row.risk.riskLevel === "high" ? "tone-danger" : "tone-warn"
          }`}
        >
          {row.risk.riskLevel}
        </span>
      ),
    },
    {
      key: "why",
      header: "Why this rating (facts → findings)",
      render: (row) => (
        <>
          <p className="tiny" style={{ margin: "0 0 0.3rem" }}>
            <strong>Facts:</strong> {row.risk.facts.join("; ")}
          </p>
          <p className="tiny" style={{ margin: "0 0 0.3rem" }}>
            <strong>Findings:</strong> {row.risk.findings.join("; ") || "—"}
          </p>
          <p className="tiny muted" style={{ margin: "0 0 0.3rem" }}>
            <strong>Unknowns:</strong> {row.risk.unknowns.join("; ") || "—"}
          </p>
          <p className="tiny muted" style={{ margin: 0 }}>
            <strong>Limitations:</strong> {row.risk.limitations.join("; ") || "—"}
          </p>
        </>
      ),
    },
  ];

  return (
    <Shell>
      <PageHead
        title="Risk findings"
        lede="Token risk assessments from the token-risk agent. Ratings separate verified facts from derived findings and explicit unknowns — the agent never states a guess as a fact."
        right={<DataSourceBadge source={source} />}
      />
      <ChainFilter value={chain} onChange={setChain} />
      <DataTable
        caption={`Risk findings on ${chain} (fixture evidence, deterministic)`}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.token.address}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load(chain) } : undefined}
        emptyTitle="No risk findings for this chain"
        emptyDetail="The risk agent needs evidence items; none were produced for this chain's fixture tokens."
      />
    </Shell>
  );
}
