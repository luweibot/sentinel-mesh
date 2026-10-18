"use client";

import { useEffect, useState } from "react";

/**
 * Shared fetch helpers. All dashboard data comes from the API or
 * orchestrator services; base URLs are public read-only endpoints only.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
export const ORCHESTRATOR_BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_BASE_URL ?? "http://localhost:3002";

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`request failed (${status})`);
    this.name = "ApiError";
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ""));
  }
  return (await response.json()) as T;
}

/** Client-only UTC timestamp: absolute + relative, hydration-safe. */
export function Timestamp({ iso, relative = true }: { iso: string | undefined | null; relative?: boolean }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!iso) return null;
  const absolute = new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return (
    <time dateTime={iso} className="nowrap" title={absolute}>
      {mounted && relative ? `${timeAgo(iso)} (${absolute.slice(0, 16)} UTC)` : absolute}
    </time>
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Data-source labeling: the dashboard must distinguish mock from live data.
// ---------------------------------------------------------------------------

export type DataSource = "fixture" | "in-memory" | "service" | "none";

export function DataSourceBadge({ source }: { source: DataSource | string | undefined }): React.JSX.Element {
  const value = source ?? "service";
  const map: Record<string, { label: string; tone: string }> = {
    fixture: { label: "fixture · deterministic mock", tone: "tone-warn" },
    "in-memory": { label: "in-memory dev buffer", tone: "tone-warn" },
    service: { label: "service data", tone: "tone-primary" },
    none: { label: "no data", tone: "" },
  };
  const entry = map[value] ?? { label: value, tone: "" };
  return <span className={`badge ${entry.tone}`}>{entry.label}</span>;
}

// ---------------------------------------------------------------------------
// Accessible data table with loading / error / empty states.
// ---------------------------------------------------------------------------

export interface Column<Row> {
  key: string;
  header: string;
  render: (row: Row) => React.ReactNode;
}

export function DataTable<Row>(props: {
  caption: string;
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  loading?: boolean;
  error?: { message: string; onRetry?: () => void };
  emptyTitle?: string;
  emptyDetail?: string;
}): React.JSX.Element {
  if (props.loading) {
    return (
      <div className="state" role="status" aria-live="polite">
        <div className="skeleton" style={{ width: "70%", height: "0.9rem" }} />
        <div className="skeleton" style={{ width: "55%", height: "0.9rem" }} />
        <div className="skeleton" style={{ width: "62%", height: "0.9rem" }} />
        Loading…
      </div>
    );
  }
  if (props.error) {
    return (
      <div className="state error" role="alert">
        <div className="state-title">Could not load this data</div>
        <p>{props.error.message}</p>
        {props.error.onRetry ? (
          <button type="button" className="btn retry" onClick={props.error.onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (props.rows.length === 0) {
    return (
      <div className="state">
        <div className="state-title">{props.emptyTitle ?? "Nothing here yet"}</div>
        {props.emptyDetail ? <p>{props.emptyDetail}</p> : null}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Chain filter: accessible aria-pressed toggle group. */
export function ChainFilter(props: { value: string; onChange: (value: string) => void; chains?: string[] }): React.JSX.Element {
  const chains = props.chains ?? ["base", "ethereum", "solana-mainnet", "solana-devnet"];
  return (
    <div className="chain-filter" role="group" aria-label="Filter by chain">
      {chains.map((chain) => (
        <button key={chain} type="button" aria-pressed={props.value === chain} onClick={() => props.onChange(chain)}>
          {chain}
        </button>
      ))}
    </div>
  );
}

/**
 * Explicit confirmation for sensitive actions: a two-step flow (arm, then
 * confirm) with an aria-describedby explanation. Used for anything that
 * creates state (authorizations, intents, workflows).
 */
export function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
  tone?: "primary" | "danger";
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <div className="confirm-panel">
      <p id="confirm-description" style={{ margin: "0 0 0.6rem" }}>{props.description}</p>
      <button type="button" className={`btn ${props.tone === "danger" ? "danger" : "primary"}`} disabled={props.disabled} aria-describedby="confirm-description" onClick={() => { setArmed(false); props.onConfirm(); }}>
        {props.confirmLabel}
      </button>{" "}
      <button type="button" className="btn" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <button type="button" className={`btn ${props.tone === "danger" ? "danger" : ""}`} disabled={props.disabled} onClick={() => setArmed(true)}>
      {props.label}
    </button>
  );
}
