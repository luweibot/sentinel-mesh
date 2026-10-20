"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { DataTable, DataSourceBadge, Timestamp, getJson, ORCHESTRATOR_BASE, type Column } from "../../components/ui";

interface ReceiptRow {
  receiptId: string;
  intentId: string;
  authorizationId: string | null;
  status: "paper-filled" | "rejected";
  executionMode: string;
  rejectionCode?: string;
  rejectionDetail?: string;
  paperTxHash?: string;
  feeUsdCents?: number;
  decidedAt: string;
  guardPipelineVersion: string;
}

export default function JournalPage(): React.JSX.Element {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyRejected, setOnlyRejected] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ receipts: ReceiptRow[] }>(`${ORCHESTRATOR_BASE}/api/v1/execution/receipts`);
      setRows(data.receipts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = onlyRejected ? rows.filter((row) => row.status === "rejected") : rows;

  const columns: Array<Column<ReceiptRow>> = [
    {
      key: "receipt",
      header: "Receipt",
      render: (row) => (
        <>
          <code className="tiny">{row.receiptId.slice(0, 8)}</code>
          <br />
          <span className="tiny muted">intent {row.intentId.slice(0, 8)} · guard v{row.guardPipelineVersion}</span>
        </>
      ),
    },
    {
      key: "auth",
      header: "Authorization",
      render: (row) =>
        row.authorizationId ? (
          <>
            <span className="badge tone-ok">consumed</span>
            <br />
            <code className="tiny">{row.authorizationId.slice(0, 8)}</code>
          </>
        ) : (
          <span className="badge tone-danger">none / invalid</span>
        ),
    },
    {
      key: "status",
      header: "Outcome",
      render: (row) => (
        <>
          <span className={`badge ${row.status === "paper-filled" ? "tone-ok" : "tone-danger"}`}>{row.status}</span>{" "}
          <span className="tiny muted">{row.executionMode}</span>
          {row.rejectionCode ? (
            <>
              <br />
              <code className="tiny">{row.rejectionCode}</code>
              {row.rejectionDetail ? <p className="tiny muted" style={{ margin: "0.2rem 0 0" }}>{row.rejectionDetail}</p> : null}
            </>
          ) : null}
        </>
      ),
    },
    { key: "fee", header: "Simulated fee", render: (row) => (row.feeUsdCents !== undefined ? `$${(row.feeUsdCents / 100).toFixed(2)}` : "—") },
    { key: "paperHash", header: "Paper artifact", render: (row) => (row.paperTxHash ? <code className="tiny">{row.paperTxHash.slice(0, 18)}…</code> : "—") },
    { key: "decided", header: "Decided", render: (row) => <Timestamp iso={row.decidedAt} /> },
  ];

  return (
    <Shell>
      <PageHead
        title="Copy-trading journal"
        lede="Every intent submitted to the guarded executor, with its authorization state, outcome, and typed fail-closed rejection codes. Each entry is a durable journal record — the source of truth for settlement and reconciliation."
        right={<DataSourceBadge source="service" />}
      />
      <div className="chain-filter" role="group" aria-label="Filter receipts">
        <button type="button" aria-pressed={!onlyRejected} onClick={() => setOnlyRejected(false)}>
          all receipts
        </button>
        <button type="button" aria-pressed={onlyRejected} onClick={() => setOnlyRejected(true)}>
          rejected only
        </button>
      </div>
      <DataTable
        caption={`${filtered.length} receipts from the guarded executor`}
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.receiptId}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load() } : undefined}
        emptyTitle="No receipts yet"
        emptyDetail="Run the guarded demo on the Execution Safety page; every submission and rejection is journaled here."
      />
    </Shell>
  );
}
