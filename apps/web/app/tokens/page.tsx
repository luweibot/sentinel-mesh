"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Shell, PageHead } from "../../components/nav";
import { ChainFilter, DataTable, DataSourceBadge, Timestamp, getJson, API_BASE, type Column } from "../../components/ui";

interface TokenRow {
  address: string;
  symbol: string;
  tvlUsd?: number;
  observedAt: string;
}

export default function TokensPage(): React.JSX.Element {
  const [chain, setChain] = useState("base");
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("fixture");

  const load = useCallback(async (selected: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{ dataSource: string; tokens: TokenRow[] }>(`${API_BASE}/api/v1/tokens?chain=${selected}`);
      setRows(data.tokens);
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

  const columns: Array<Column<TokenRow>> = [
    {
      key: "token",
      header: "Token",
      render: (row) => (
        <>
          <strong>{row.symbol}</strong>
          <br />
          <code className="tiny">{row.address}</code>
        </>
      ),
    },
    {
      key: "tvl",
      header: "TVL (USD, fixture)",
      render: (row) => (row.tvlUsd !== undefined ? `$${row.tvlUsd.toFixed(2)}` : <span className="muted">—</span>),
    },
    { key: "observed", header: "Observed", render: (row) => <Timestamp iso={row.observedAt} /> },
    {
      key: "detail",
      header: "Detail",
      render: (row) => (
        <Link className="tiny" href={`/tokens/${chain}/${row.address}`}>
          evidence & risk →
        </Link>
      ),
    },
  ];

  return (
    <Shell>
      <PageHead
        title="Token explorer"
        lede="Candidate tokens discovered by the data layer, with pool liquidity observations. All values on this page come from deterministic fixtures — no chain RPC is called in this phase."
        right={<DataSourceBadge source={source} />}
      />
      <ChainFilter value={chain} onChange={setChain} />
      <DataTable
        caption={`Discovered tokens on ${chain} (deterministic fixture data)`}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.address}
        loading={loading}
        error={error ? { message: error, onRetry: () => void load(chain) } : undefined}
        emptyTitle="No tokens discovered for this chain"
        emptyDetail="The fixture discovery provider returned no candidates for this chain."
      />
    </Shell>
  );
}
