"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../components/nav";
import { API_BASE, ORCHESTRATOR_BASE, DataSourceBadge, getJson } from "../components/ui";

interface HealthInfo {
  status: string;
  service: string;
  version: string;
  time: string;
  uptimeSec?: number;
}

export default function OverviewPage(): React.JSX.Element {
  const [api, setApi] = useState<HealthInfo | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [orchestrator, setOrchestrator] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [apiHealth, orchHealth, agents] = await Promise.all([
        getJson<HealthInfo>(`${API_BASE}/health`),
        getJson<HealthInfo>(`${ORCHESTRATOR_BASE}/health`),
        getJson<{ total: number }>(`${API_BASE}/api/v1/agents`),
      ]);
      setApi(apiHealth);
      setOrchestrator(orchHealth);
      setAgentCount(agents.total);
    } catch (err) {
      setError(err instanceof Error ? `${err.message} — is the service running?` : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell>
      <PageHead
        title="Overview"
        lede="Collaborative multi-agent Web3 intelligence and guarded-trading platform. This build is paper-only: agents observe deterministic fixture data, and the only executor is the guarded paper executor with mock signing."
        right={<DataSourceBadge source="service" />}
      />

      {loading ? <div className="state" role="status">Loading service health…</div> : null}
      {error ? (
        <div className="state error" role="alert">
          <div className="state-title">Backend unreachable</div>
          <p>{error}</p>
          <button type="button" className="btn retry" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="stat-grid">
        <div className="stat">
          <div className="label">Agents registered</div>
          <div className="value">{agentCount ?? "…"}</div>
          <DataSourceBadge source="service" />
        </div>
        <div className="stat">
          <div className="label">Chains observed (fixtures)</div>
          <div className="value">4</div>
          <span className="badge tone-warn">base · ethereum · solana×2</span>
        </div>
        <div className="stat">
          <div className="label">Execution mode</div>
          <div className="value">paper</div>
          <span className="badge tone-warn">mock signing, never broadcast</span>
        </div>
        <div className="stat">
          <div className="label">Live trading</div>
          <div className="value">disabled</div>
          <span className="badge tone-ok">rejected at config load</span>
        </div>
      </div>

      <div className="grid" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h2>API service</h2>
          {api ? (
            <>
              <p style={{ margin: "0.2rem 0" }}>
                <span className={`badge ${api.status === "ok" ? "tone-ok" : "tone-danger"}`}>{api.status}</span>{" "}
                <code>{api.service}</code>
              </p>
              <p className="tiny muted" style={{ margin: "0.2rem 0 0" }}>
                v{api.version} · {API_BASE} · uptime {api.uptimeSec ?? "?"}s
              </p>
            </>
          ) : (
            <p className="muted">not reachable</p>
          )}
        </div>
        <div className="card">
          <h2>Orchestrator service</h2>
          {orchestrator ? (
            <>
              <p style={{ margin: "0.2rem 0" }}>
                <span className={`badge ${orchestrator.status === "ok" ? "tone-ok" : "tone-danger"}`}>{orchestrator.status}</span>{" "}
                <code>{orchestrator.service}</code>
              </p>
              <p className="tiny muted" style={{ margin: "0.2rem 0 0" }}>
                v{orchestrator.version} · {ORCHESTRATOR_BASE} · uptime {orchestrator.uptimeSec ?? "?"}s
              </p>
            </>
          ) : (
            <p className="muted">not reachable</p>
          )}
        </div>
      </div>

      <div className="notice">
        <strong>Guardrails, always on in this phase:</strong> chain adapters are deterministic in-process fixtures (no RPC calls), the only
        signer is a mock signer, guarded execution fails closed without a short-lived exact-bound authorization, and config rejects
        <code> EXECUTION_MODE=live</code>. No component in this repository can broadcast a transaction.
      </div>
    </Shell>
  );
}
