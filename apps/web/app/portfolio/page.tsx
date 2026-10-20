"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Shell, PageHead } from "../../components/nav";
import { DataSourceBadge, Timestamp, getJson, API_BASE } from "../../components/ui";

interface PortfolioResponse {
  dataSource: string;
  status: string;
  detail: string;
}

export default function PortfolioPage(): React.JSX.Element {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getJson<PortfolioResponse>(`${API_BASE}/api/v1/portfolio`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell>
      <PageHead
        title="Portfolio analytics"
        lede="Position and PnL analytics across chains. This page intentionally shows no numbers in this phase."
        right={data ? <DataSourceBadge source={data.dataSource} /> : null}
      />
      {error ? (
        <div className="state error" role="alert">
          <div className="state-title">Could not load portfolio status</div>
          <p>{error}</p>
        </div>
      ) : null}
      <div className="state">
        <div className="state-title">No attributed fills yet</div>
        <p>
          Portfolio analytics require attributed fills from the guarded executor. None are attributed to a portfolio yet, so this page shows an honest empty state instead of fabricated performance metrics.
        </p>
        {data ? <p className="tiny">{data.detail}</p> : null}
        <p className="tiny">
          Receipts that do exist are listed on the{" "}
          <Link href="/journal">copy-trading journal</Link> page.
        </p>
      </div>
      <div className="card">
        <h2>What will be here later</h2>
        <ul className="tiny muted" style={{ paddingLeft: "1rem" }}>
          <li>Open positions per chain, derived from attributed executor receipts.</li>
          <li>Realized vs. simulated PnL, with the simulation-vs-execution gap made explicit.</li>
          <li>Exposure and loss-cap utilization against the per-user limit policy.</li>
        </ul>
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
void Timestamp;
