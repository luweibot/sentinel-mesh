"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import {
  ConfirmButton,
  DataTable,
  DataSourceBadge,
  getJson,
  postJson,
  ORCHESTRATOR_BASE,
  type Column,
} from "../../components/ui";

interface PaymentRecordRow {
  paymentId: string;
  agentId: string;
  chain: string;
  asset: string;
  amount: string;
  status: string;
  nonce: string;
  transactionHash?: string;
  grants: { contentAccess: boolean; trading: boolean };
  recordedAt: string;
}

interface ReconcileReport {
  ranAt: string;
  recordsChecked: number;
  settledWithoutEvidence: string[];
  duplicateNonces: string[];
  consistent: boolean;
}

interface PaymentsResponse {
  records: PaymentRecordRow[];
  reconcile: ReconcileReport;
  semantics: string;
}

/** x402 demo fixture values (must match the orchestrator's allowlists). */
const DEMO_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC on Base (fixture)
const DEMO_PAY_TO = "0x9990000000000000000000000000000000000001"; // fixture recipient
const DEMO_FROM = "0x1110000000000000000000000000000000000001";
const DEMO_AMOUNT = "1000000"; // 1,000,000 units = $1.00 at 6 decimals

/** Deterministic pseudo-signature (fixture only; treated as opaque evidence). */
function paymentSignatureOf(nonce: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(nonce)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

function buildDemoPayment(): { requirement: Record<string, unknown>; payment: Record<string, unknown> } {
  const now = Date.now();
  const nonce = crypto.randomUUID();
  return {
    requirement: {
      scheme: "exactInEvm",
      network: 8453,
      asset: DEMO_ASSET,
      maxAmountRequired: DEMO_AMOUNT,
      payTo: DEMO_PAY_TO,
      maxTimeoutSeconds: 300,
      mimeType: "application/json",
      extra: { name: "sentinel-mesh-data", version: "1", description: "dashboard demo" },
    },
    payment: {
      x402Version: "1",
      scheme: "exactInEvm",
      payload: {
        from: DEMO_FROM,
        to: DEMO_PAY_TO,
        value: DEMO_AMOUNT,
        nonce,
        validAfter: new Date(now - 60_000).toISOString(),
        validBefore: new Date(now + 300_000).toISOString(),
        signature: paymentSignatureOf(nonce),
      },
    },
  };
}

function formatUsd(raw: string): string {
  const units = Number(raw);
  if (!Number.isFinite(units)) return raw;
  return `$${(units / 1_000_000).toFixed(2)}`;
}

function shortHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export default function PaymentsPage(): React.JSX.Element {
  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoState, setDemoState] = useState<"idle" | "recorded" | "settled">("idle");
  const [demoPaymentId, setDemoPaymentId] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson<PaymentsResponse>(`${ORCHESTRATOR_BASE}/api/v1/payments`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<PaymentRecordRow>> = [
    { key: "paymentId", header: "Payment", render: (row) => <code className="tiny">{shortHex(row.paymentId)}</code> },
    { key: "agentId", header: "Agent", render: (row) => <code className="tiny">{row.agentId}</code> },
    { key: "amount", header: "Amount", render: (row) => formatUsd(row.amount) },
    { key: "status", header: "Status", render: (row) => <span className={`badge ${row.status === "settled" ? "tone-primary" : ""}`}>{row.status}</span> },
    { key: "grants", header: "Grants", render: (row) => (
      <span className="tiny">
        content: {row.grants?.contentAccess ? "yes" : "no"} · trading: <strong>never</strong>
      </span>
    ) },
    { key: "tx", header: "Settlement", render: (row) => (row.transactionHash ? <code className="tiny">{shortHex(row.transactionHash)}</code> : "—") },
  ];

  async function runDemoVerify(): Promise<void> {
    setBusy(true);
    setDemoError(null);
    try {
      const paymentId = crypto.randomUUID();
      const { requirement, payment } = buildDemoPayment();
      const verdict = await postJson<{ ok: boolean; code?: string; message?: string; record?: { status: string } }>(
        `${ORCHESTRATOR_BASE}/api/v1/payments/verify`,
        { agentId: "trend-scout-agent", requirement, payment, paymentId },
      );
      if (!verdict.ok) {
        setDemoError(`Rejected (${verdict.code ?? "unknown"}): ${verdict.message ?? ""}`);
        return;
      }
      setDemoPaymentId(paymentId);
      setDemoState("recorded");
      setDemoResult("Payment verified and recorded. The guard checked scheme, chain, asset, recipient, amount, expiry window, nonce uniqueness, and the per-agent spend cap. Now submit settlement evidence.");
      await load();
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runDemoSettle(): Promise<void> {
    if (!demoPaymentId) return;
    setBusy(true);
    setDemoError(null);
    try {
      const verdict = await postJson<{ ok: boolean; code?: string; message?: string; record?: { status: string; transactionHash?: string } }>(
        `${ORCHESTRATOR_BASE}/api/v1/payments/settle`,
        {
          paymentId: demoPaymentId,
          settlement: {
            scheme: "exactInEvm",
            network: 8453,
            payload: { success: true, transactionHash: `mock-tx-${demoPaymentId.slice(0, 8)}` },
            facilitatorId: "mock-facilitator",
          },
        },
      );
      if (!verdict.ok) {
        setDemoError(`Settlement rejected (${verdict.code ?? "unknown"}): ${verdict.message ?? ""}`);
        return;
      }
      setDemoState("settled");
      setDemoResult(`Settled via the allowlisted mock facilitator. The record grants content access only — grants.trading is structurally false.`);
      await load();
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <PageHead
        title="x402 payments"
        lede="Machine payments for data access, verified end to end: requirement and payload validation, replay resistance, per-agent spend caps, and settlement evidence from allowlisted facilitators. A payment grants content access — never trading authority."
        right={<DataSourceBadge source="service" />}
      />
      {error ? (
        <div className="state error" role="alert">
          <div className="state-title">Could not load payments</div>
          <p>{error}</p>
        </div>
      ) : null}
      <div className="card">
        <h2>Reconciliation</h2>
        {data ? (
          <p className="tiny muted">
            {data.reconcile.consistent ? "✓ Ledger consistent" : "⚠ Inconsistencies detected"} · {data.reconcile.recordsChecked} records
            checked · settled without evidence: {data.reconcile.settledWithoutEvidence.length} · duplicate nonces:{" "}
            {data.reconcile.duplicateNonces.length}
          </p>
        ) : (
          <p className="tiny muted">Loading…</p>
        )}
      </div>
      <DataTable
        caption="Payment records (mock facilitator; no real funds move)"
        columns={columns}
        rows={data?.records ?? []}
        rowKey={(row) => row.paymentId}
        loading={!data && !error}
        emptyTitle="No payments recorded"
        emptyDetail="Run the demo below to push a deterministic fixture payment through the guard."
      />
      <div className="card">
        <h2>Demo: verify and settle a fixture payment</h2>
        <p className="tiny muted">
          The demo builds an x402 requirement and payment payload client-side (fixture USDC on Base, fixture recipient), then walks the
          real guard flow: verify → record → settle with facilitator evidence. No keys, no network, no real funds.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <ConfirmButton
            label={busy && demoState === "idle" ? "Verifying…" : "Verify demo payment"}
            confirmLabel="Confirm: submit the fixture payment"
            description="Creates one deterministic fixture payment record in the in-memory ledger. It grants content access only."
            disabled={busy || demoState !== "idle"}
            onConfirm={() => void runDemoVerify()}
          />
          <ConfirmButton
            label={busy && demoState === "recorded" ? "Settling…" : "Submit settlement evidence"}
            confirmLabel="Confirm: settle with the mock facilitator"
            description="Submits settlement evidence from the allowlisted mock facilitator and marks the record settled."
            disabled={busy || demoState !== "recorded"}
            onConfirm={() => void runDemoSettle()}
          />
        </div>
        {demoResult ? <p className="tiny" style={{ marginTop: "0.6rem" }}>{demoResult}</p> : null}
        {demoError ? <p className="tiny" style={{ marginTop: "0.6rem", color: "var(--danger)" }}>{demoError}</p> : null}
      </div>
      <div className="notice">
        <strong>Scope:</strong> only the deterministic mock facilitator is wired in. Enabling a live x402 facilitator requires an ADR, an
        allowlist update, and a config flag — it is never enabled by a payment itself.
      </div>
    </Shell>
  );
}
