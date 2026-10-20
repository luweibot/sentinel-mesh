"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { ConfirmButton, DataTable, DataSourceBadge, Timestamp, getJson, postJson, ORCHESTRATOR_BASE, type Column } from "../../components/ui";

interface KillSwitchSnapshot {
  snapshot: { global: string; users: Record<string, string>; strategies: Record<string, string> };
  semantics: string;
}

interface ReceiptRow {
  receiptId: string;
  intentId: string;
  status: string;
  authorizationId: string | null;
  rejectionCode?: string;
  rejectionDetail?: string;
  decidedAt: string;
}

interface ReconcileReport {
  ranAt: string;
  receiptsChecked: number;
  missingReceipts: string[];
  duplicateReceipts: string[];
  mismatches: Array<{ intentId: string; problem: string }>;
  consistent: boolean;
}

const DEMO_INTENT = {
  schemaVersion: 1,
  intentId: "00000000-0000-4000-8000-000000000001",
  userId: "demo-user",
  strategyId: "demo-strategy",
  chain: "base",
  tokenIn: "0xabc0000000000000000000000000000000000001",
  tokenOut: "0xdef0000000000000000000000000000000000002",
  amountInRaw: "1000000",
  minAmountOutRaw: "0",
  maxFeeUsdCents: 100,
  maxPriceImpactBps: 100,
  deadline: new Date(Date.now() + 120_000).toISOString(),
};

export default function ExecutionPage(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<KillSwitchSnapshot | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [authorization, setAuthorization] = useState<{ authorizationId: string; status: string; expiresAt: string } | null>(null);
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [snap, rec] = await Promise.all([
        getJson<KillSwitchSnapshot>(`${ORCHESTRATOR_BASE}/api/v1/execution/kill-switch`),
        getJson<{ report: ReconcileReport }>(`${ORCHESTRATOR_BASE}/api/v1/execution/reconcile`),
      ]);
      setSnapshot(snap);
      setReport(rec.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function freshIntent(): typeof DEMO_INTENT {
    return { ...DEMO_INTENT, intentId: crypto.randomUUID(), deadline: new Date(Date.now() + 120_000).toISOString() };
  }

  async function mintAuthorization(): Promise<void> {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const data = await postJson<{ authorization: { authorizationId: string; status: string; expiresAt: string } }>(
        `${ORCHESTRATOR_BASE}/api/v1/execution/authorizations`,
        { intent: freshIntent() },
      );
      setAuthorization(data.authorization);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitIntent(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const intent = freshIntent();
      const minted = await postJson<{ authorization: { authorizationId: string; status: string; expiresAt: string } }>(
        `${ORCHESTRATOR_BASE}/api/v1/execution/authorizations`,
        { intent },
      );
      const data = await postJson<{ receipt: ReceiptRow }>(`${ORCHESTRATOR_BASE}/api/v1/execution/intents`, {
        intent,
        authorization: minted.authorization,
      });
      setAuthorization(minted.authorization);
      setReceipt(data.receipt);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleKillSwitch(state: "engaged" | "clear"): Promise<void> {
    setBusy(true);
    try {
      await postJson(`${ORCHESTRATOR_BASE}/api/v1/execution/kill-switch`, { scope: "global", state });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const receiptColumns: Array<Column<ReceiptRow>> = [
    { key: "receipt", header: "Receipt", render: (row) => <code className="tiny">{row.receiptId.slice(0, 8)}</code> },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <>
          <span className={`badge ${row.status === "paper-filled" ? "tone-ok" : "tone-danger"}`}>{row.status}</span>
          {row.rejectionCode ? (
            <>
              <br />
              <code className="tiny">{row.rejectionCode}</code>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: "auth",
      header: "Authorization",
      render: (row) => (row.authorizationId ? <code className="tiny">{row.authorizationId.slice(0, 8)} (consumed)</code> : <span className="badge tone-danger">none</span>),
    },
    { key: "decided", header: "Decided", render: (row) => <Timestamp iso={row.decidedAt} /> },
  ];

  return (
    <Shell>
      <PageHead
        title="Execution safety"
        lede="The guarded execution pipeline: kill switches, exact-bound short-lived authorizations, and reconciliation. Every intent is fail-closed unless a matching short-lived authorization is presented and consumed."
        right={<DataSourceBadge source="service" />}
      />

      {error ? (
        <div className="state error" role="alert">
          <div className="state-title">Error</div>
          <p>{error}</p>
        </div>
      ) : null}

      <div className="grid">
        <div className="card">
          <h2>Kill switch</h2>
          {snapshot ? (
            <>
              <p style={{ margin: "0.2rem 0" }}>
                global:{" "}
                <span className={`badge ${snapshot.snapshot.global === "clear" ? "tone-ok" : "tone-danger"}`}>
                  {snapshot.snapshot.global}
                </span>{" "}
                <span className="tiny muted">{snapshot.semantics}</span>
              </p>
              <p className="tiny muted" style={{ margin: "0.4rem 0 0.8rem" }}>
                Engaging stops every submission globally, per user, or per strategy. Unknown state fails closed.
              </p>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="button" className="btn" disabled={busy} onClick={() => void toggleKillSwitch("clear")}>
                  Release (clear)
                </button>
                <ConfirmButton
                  label="Engage kill switch"
                  confirmLabel="Confirm: engage the global kill switch"
                  description="All execution submissions will be rejected with kill-switch-engaged until explicitly released."
                  tone="danger"
                  disabled={busy}
                  onConfirm={() => void toggleKillSwitch("engaged")}
                />
              </div>
            </>
          ) : (
            <p className="muted">loading…</p>
          )}
        </div>

        <div className="card">
          <h2>Reconciliation</h2>
          {report ? (
            <>
              <p style={{ margin: "0.2rem 0" }}>
                <span className={`badge ${report.consistent ? "tone-ok" : "tone-danger"}`}>{report.consistent ? "consistent" : "mismatch"}</span>{" "}
                <span className="tiny muted">{report.receiptsChecked} receipts checked · ran <Timestamp iso={report.ranAt} /></span>
              </p>
              {report.mismatches.length > 0 ? (
                <ul className="tiny muted" style={{ paddingLeft: "1rem" }}>
                  {report.mismatches.map((mismatch) => (
                    <li key={mismatch.intentId}>{mismatch.problem}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="muted">loading…</p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Guarded execution demo</h2>
        <p className="tiny muted">
          Step 1: an authorization is minted for the exact intent parameters (60s TTL, single use). Step 2: submitting runs the full guard
          pipeline — kill switch, idempotency, policy engine, authorization binding, limits, liquidity, simulation, fee/slippage bounds, and
          chain-specific transaction validation — before a signed receipt is produced. In paper mode the receipt is a mock-signed artifact; in live mode the same pipeline broadcasts a real transaction.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void mintAuthorization()}>
            1. Mint demo authorization
          </button>
          <ConfirmButton
            label="2. Submit authorized intent"
            confirmLabel="Confirm: submit this intent"
            description="Submits an intent through the guarded executor. The exact-bound authorization is consumed on use and every step is journaled."
            disabled={busy}
            onConfirm={() => void submitIntent()}
          />
        </div>
        {authorization ? (
          <p className="tiny" style={{ marginTop: "0.7rem" }}>
            Authorization status: <span className="badge tone-ok">{authorization.status}</span>{" "}
            <code className="tiny">{authorization.authorizationId.slice(0, 8)}</code> · expires <Timestamp iso={authorization.expiresAt} />
          </p>
        ) : null}
        {receipt ? (
          <div style={{ marginTop: "0.6rem" }}>
            <DataTable caption="Receipt for the submitted intent" columns={receiptColumns} rows={[receipt]} rowKey={(row) => row.receiptId} />
          </div>
        ) : null}
      </div>

      <div className="notice">
        <strong>Security properties (implemented and tested):</strong> replay and duplicate submissions fail closed; altered parameters
        (intent-hash-mismatch), wrong chain, expired/revoked/missing authorizations, excessive spend over per-user and per-strategy caps,
        position and daily-loss caps, insufficient liquidity, fee/slippage/price-impact bounds, simulation uncertainty, and kill switches all
        reject with typed codes. The frontend holds no keys, secrets, or signing logic and cannot bypass a guard.
      </div>
    </Shell>
  );
}
