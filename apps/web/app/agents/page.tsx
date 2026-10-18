"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { DataTable, DataSourceBadge, getJson, API_BASE, type Column } from "../../components/ui";

interface AgentManifest {
  agentId: string;
  displayName: string;
  version: string;
  description: string;
  capabilities: string[];
  supportedTaskTypes: string[];
  permissions: { networkAccess: string; canSignTransactions: boolean };
  chainAffinity: string[];
}

interface Row {
  agentId: string;
  displayName: string;
  version: string;
  capabilities: string[];
  taskTypes: string[];
  network: string;
  canSign: boolean;
  chains: string[];
}

function toRow(manifest: AgentManifest): Row {
  return {
    agentId: manifest.agentId,
    displayName: manifest.displayName,
    version: manifest.version,
    capabilities: manifest.capabilities,
    taskTypes: manifest.supportedTaskTypes,
    network: manifest.permissions.networkAccess,
    canSign: manifest.permissions.canSignTransactions,
    chains: manifest.chainAffinity,
  };
}

export default function AgentsPage(): React.JSX.Element {
  const [capability, setCapability] = useState("all");
  const [manifests, setManifests] = useState<AgentManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ agents: AgentManifest[] }>(`${API_BASE}/api/v1/agents`);
      setManifests(data.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => manifests.map(toRow), [manifests]);
  const capabilities = useMemo(() => ["all", ...Array.from(new Set(rows.flatMap((r) => r.capabilities))).sort()], [rows]);
  const filtered = capability === "all" ? rows : rows.filter((row) => row.capabilities.includes(capability));

  const columns: Array<Column<Row>> = [
    {
      key: "agent",
      header: "Agent",
      render: (row) => (
        <>
          <strong>{row.displayName}</strong>
          <br />
          <code>{row.agentId}</code> <span className="muted tiny">v{row.version}</span>
        </>
      ),
    },
    { key: "capabilities", header: "Capabilities", render: (row) => row.capabilities.map((c) => <span key={c} className="badge tone-primary" style={{ marginRight: 4 }}>{c}</span>) },
    { key: "tasks", header: "Task types", render: (row) => row.taskTypes.map((t) => <code key={t} style={{ marginRight: 6 }}>{t}</code>) },
    { key: "chains", header: "Chain affinity", render: (row) => <span className="tiny">{row.chains.join(", ") || "—"}</span> },
    {
      key: "permissions",
      header: "Permissions",
      render: (row) => (
        <>
          <span className={`badge ${row.network === "none" ? "tone-ok" : "tone-warn"}`}>network: {row.network}</span>{" "}
          <span className={`badge ${row.canSign ? "tone-danger" : "tone-ok"}`}>{row.canSign ? "can sign" : "cannot sign"}</span>
        </>
      ),
    },
  ];

  return (
    <Shell>
      <PageHead
        title="Agent registry"
        lede="Every agent in the mesh, its declared capabilities, and its least-privilege permissions. No agent can sign transactions in this phase."
        right={<DataSourceBadge source="service" />}
      />
      <div className="chain-filter" role="group" aria-label="Filter by capability">
        {capabilities.map((item) => (
          <button key={item} type="button" aria-pressed={capability === item} onClick={() => setCapability(item)}>
            {item}
          </button>
        ))}
      </div>
      <DataTable
        caption={`${filtered.length} of ${rows.length} registered agents`}
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.agentId}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load() } : undefined}
        emptyTitle="No agents match this capability"
        emptyDetail="Clear the filter to see all registered agents."
      />
    </Shell>
  );
}
