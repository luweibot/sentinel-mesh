"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import { ConfirmButton, DataTable, DataSourceBadge, Timestamp, getJson, postJson, API_BASE, type Column } from "../../components/ui";

interface SignalRow {
  signal: {
    signalId: string;
    chain: string;
    kind: string;
    tokenIn: string;
    tokenOut: string;
    notionalUsdCents: number;
    sourceWallet?: string;
  };
  decision: { verdict: string; executionMode: string; reasons: Array<{ code: string; message: string; severity: string }>; policyVersion: string };
  recordedAt: string;
}

export default function SignalsPage(): React.JSX.Element {
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [chain, setChain] = useState("base");
  const [notional, setNotional] = useState("1000");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ signals: SignalRow[]; detail: string }>(`${API_BASE}/api/v1/signals`);
      setRows(data.signals);
      setDetail(data.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function postSignal(): Promise<void> {
    setPosting(true);
    try {
      const cents = Math.round(Number(notional) * 100);
      await postJson(`${API_BASE}/api/v1/signals`, {
        chain,
        kind: "copy-trade",
        tokenIn: "0xabc0000000000000000000000000000000000001",
        tokenOut: "0xdef0000000000000000000000000000000000002",
        notionalUsdCents: Number.isFinite(cents) && cents > 0 ? cents : 1000,
        sourceWallet: "0xdef0000000000000000000000000000000000009",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  const columns: Array<Column<SignalRow>> = [
    {
      key: "signal",
      header: "Signal",
      render: (row) => (
        <>
          <span className="badge tone-primary">{row.signal.kind}</span> <span className="badge">{row.signal.chain}</span>
          <br />
          <code className="tiny">{row.signal.signalId.slice(0, 8)}</code>
        </>
      ),
    },
    {
      key: "pair",
      header: "Pair / notional",
      render: (row) => (
        <>
          <code className="tiny">{row.signal.tokenIn.slice(0, 10)}… → {row.signal.tokenOut.slice(0, 10)}…</code>
          <br />
          <span className="tiny">${(row.signal.notionalUsdCents / 100).toFixed(2)}</span>
        </>
      ),
    },
    {
      key: "attribution",
      header: "Attributed source",
      render: (row) => (row.signal.sourceWallet ? <code className="tiny">{row.signal.sourceWallet.slice(0, 14)}…</code> : <span className="muted">unattributed</span>),
    },
    {
      key: "decision",
      header: "Policy decision",
      render: (row) => (
        <>
          <span className={`badge ${row.decision.verdict === "allow" ? "tone-ok" : row.decision.verdict === "reject" ? "tone-danger" : "tone-warn"}`}>
            {row.decision.verdict}
          </span>{" "}
          <span className="tiny muted">mode: {row.decision.executionMode}</span>
          {row.decision.reasons.length > 0 ? (
            <ul className="tiny muted" style={{ margin: "0.3rem 0 0", paddingLeft: "1rem" }}>
              {row.decision.reasons.map((reason) => (
                <li key={reason.code}>{reason.message}</li>
              ))}
            </ul>
          ) : null}
        </>
      ),
    },
    { key: "recorded", header: "Recorded", render: (row) => <Timestamp iso={row.recordedAt} /> },
  ];

  return (
    <Shell>
      <PageHead
        title="Attributed signals"
        lede="Copy-trade signals with their source wallet and the independent policy engine's decision. Signals never execute anything in this phase — the pipeline records them and evaluates policy only."
        right={<DataSourceBadge source="in-memory" />}
      />

      <div className="card">
        <h2>Post a test signal</h2>
        <p className="tiny muted">Uses fixture token addresses; the API evaluates it against the deterministic policy engine. Requires explicit confirmation because it creates records.</p>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="signal-chain">Chain</label>
            <select id="signal-chain" value={chain} onChange={(event) => setChain(event.target.value)}>
              <option value="base">base</option>
              <option value="ethereum">ethereum</option>
              <option value="solana">solana</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="signal-notional">Notional (USD)</label>
            <input id="signal-notional" value={notional} onChange={(event) => setNotional(event.target.value)} inputMode="decimal" />
          </div>
          <ConfirmButton
            label={posting ? "Posting…" : "Post signal"}
            confirmLabel="Confirm: post this signal"
            description="This creates a signal record and a policy decision. It does not and cannot execute a trade."
            disabled={posting}
            onConfirm={() => void postSignal()}
          />
        </div>
      </div>

      {detail ? <p className="tiny muted">{detail}</p> : null}
      <DataTable
        caption="Recent signals with attribution and policy decisions"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.signal.signalId}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load() } : undefined}
        emptyTitle="No signals recorded yet"
        emptyDetail="Post a test signal above; posted signals appear here with their policy decision."
      />
    </Shell>
  );
}
