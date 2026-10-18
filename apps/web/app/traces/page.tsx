"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { DataTable, DataSourceBadge, Timestamp, getJson, ORCHESTRATOR_BASE, type Column } from "../../components/ui";

interface RunRow {
  runId: string;
  workflowName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export default function TracesPage(): React.JSX.Element {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ runs: RunRow[] }>(`${ORCHESTRATOR_BASE}/api/v1/workflows`);
      setRuns(data.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<RunRow>> = [
    {
      key: "run",
      header: "Run",
      render: (row) => (
        <>
          <code>{row.runId.slice(0, 8)}</code>
          <br />
          <span className="tiny muted">{row.workflowName}</span>
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <span className={`badge ${row.status === "completed" ? "tone-ok" : row.status === "failed" ? "tone-danger" : "tone-warn"}`}>{row.status}</span>,
    },
    { key: "created", header: "Started", render: (row) => <Timestamp iso={row.createdAt} /> },
    { key: "updated", header: "Last update", render: (row) => <Timestamp iso={row.updatedAt} /> },
  ];

  return (
    <Shell>
      <PageHead
        title="Workflow traces"
        lede="Recent multi-agent workflow runs from the orchestrator, with per-step task records. Start one from the Skills page."
        right={<DataSourceBadge source="service" />}
      />
      <DataTable
        caption="Recent workflow runs (newest first)"
        columns={columns}
        rows={runs}
        rowKey={(row) => row.runId}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load() } : undefined}
        emptyTitle="No workflow runs yet"
        emptyDetail="Runs appear here after you trigger one from the Skills page. Each run's step records are visible on the orchestrator's /api/v1/workflows/:runId endpoint."
      />
    </Shell>
  );
}
