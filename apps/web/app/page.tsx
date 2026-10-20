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

interface ReadyInfo {
  status: string;
  checks?: {
    storage?: { mode?: string };
    policy?: { mode?: string; executionMode?: string };
    database?: { configured?: boolean; status?: string };
  };
}

interface PaymentsCatalog {
  mode: string;
  receiver: string;
  asset: string;
  services: Array<{ serviceId: string; priceUsd: string }>;
}

export default function OverviewPage(): React.JSX.Element {
  const [orchestrator, setOrchestrator] = useState<HealthInfo | null>(null);
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [payments, setPayments] = useState<PaymentsCatalog | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orchHealth, readyInfo, catalog, agents] = await Promise.all([
        getJson<HealthInfo>(`${ORCHESTRATOR_BASE}/health`),
        getJson<ReadyInfo>(`${ORCHESTRATOR_BASE}/health/ready`),
        getJson<PaymentsCatalog>(`${ORCHESTRATOR_BASE}/api/v1/payments/catalog`),
        getJson<{ total: number }>(`${API_BASE}/api/v1/agents`),
      ]);
      setOrchestrator(orchHealth);
      setReady(readyInfo);
      setPayments(catalog);
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

  const executionMode = ready?.checks?.policy?.executionMode ?? "…";

  return (
    <Shell>
      <PageHead
        title="Overview"
        lede="Collaborative multi-agent Web3 intelligence platform, live on Base and Solana mainnets. Paid API access settles per call in USDC via x402; guarded execution runs behind exact-bound authorizations, spend caps, a durable journal, and a kill switch."
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
          <div className="label">Chains observed</div>
          <div className="value">2</div>
          <span className="badge tone-warn">base · solana</span>
        </div>
        <div className="stat">
          <div className="label">Execution mode</div>
          <div className="value">{executionMode}</div>
          <span className="badge tone-warn">guarded executor, durable journal</span>
        </div>
        <div className="stat">
          <div className="label">x402 payments</div>
          <div className="value">{payments ? payments.mode : "…"}</div>
          <span className="badge tone-ok">{payments ? `USDC per call · ${payments.services.length} services` : "loading catalog…"}</span>
        </div>
      </div>

      <div className="grid" style={{ marginTop: "1rem" }}>
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
        <div className="card">
          <h2>Paid API (x402)</h2>
          {payments ? (
            <>
              <p style={{ margin: "0.2rem 0" }}>
                <span className={`badge ${payments.mode === "live" ? "tone-ok" : "tone-warn"}`}>{payments.mode}</span>{" "}
                <code>{payments.services.length} metered services</code>
              </p>
              <p className="tiny muted" style={{ margin: "0.2rem 0 0" }}>
                Receiver <code>{payments.receiver.slice(0, 10)}…</code> · {payments.asset}
              </p>
            </>
          ) : (
            <p className="muted">catalog not reachable</p>
          )}
        </div>
      </div>

      <div className="notice">
        <strong>Safety architecture, always on:</strong> execution is fail-closed without a short-lived exact-bound authorization,
        every intent and settlement is recorded in the durable Postgres journal, per-user spend caps are enforced before any
        broadcast, a global kill switch rejects execution when engaged, and the treasury auto-converts settled USDC revenue into
        just-enough gas. This dashboard is read-only: it holds no keys, secrets, or signing logic.
      </div>
    </Shell>
  );
}
