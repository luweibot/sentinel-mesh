import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, ChainFilter, ConfirmButton, DataSourceBadge, Timestamp, timeAgo } from "../components/ui";

interface TestRow { id: string; name: string }

function makeTable(overrides: Partial<Parameters<typeof DataTable<TestRow>>[0]> = {}) {
  return (
    <DataTable<TestRow>
      caption="test table"
      columns={[
        { key: "name", header: "Name", render: (row) => row.name },
        { key: "value", header: "Value", render: (row) => <code>{row.name.toUpperCase()}</code> },
      ]}
      rows={[{ id: "1", name: "alpha" }, { id: "2", name: "beta" }]}
      rowKey={(row) => row.id}
      {...overrides}
    />
  );
}

describe("DataTable", () => {
  it("renders an accessible table with caption, headers, and rows", () => {
    render(makeTable());
    const table = screen.getByRole("table", { name: /test table/i });
    expect(table).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /name/i })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "BETA" })).toBeTruthy();
  });

  it("shows the empty state with title and detail when there are no rows", () => {
    render(makeTable({ rows: [], emptyTitle: "Nothing yet", emptyDetail: "Post a signal to populate this." }));
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.getByText("Post a signal to populate this.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the loading state as a live region", () => {
    render(makeTable({ loading: true }));
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows the error state with a retry button", async () => {
    const onRetry = vi.fn();
    render(makeTable({ error: { message: "backend unreachable", onRetry } }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/backend unreachable/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("ChainFilter", () => {
  it("filters are aria-pressed toggle buttons and report selection", async () => {
    const onChange = vi.fn();
    render(<ChainFilter value="base" onChange={onChange} />);
    const base = screen.getByRole("button", { name: "base" });
    const ethereum = screen.getByRole("button", { name: "ethereum" });
    expect(base.getAttribute("aria-pressed")).toBe("true");
    expect(ethereum.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(ethereum);
    expect(onChange).toHaveBeenCalledWith("ethereum");
  });
});

describe("ConfirmButton", () => {
  it("requires an explicit two-step confirmation before acting", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        label="Submit"
        confirmLabel="Confirm: submit"
        description="This is sensitive."
        onConfirm={onConfirm}
      />,
    );
    // First click only arms the confirmation; nothing fires yet.
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onConfirm).not.toHaveBeenCalled();
    // The description is exposed to assistive tech before confirming.
    expect(screen.getByText("This is sensitive.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /confirm: submit/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Cancelling never fires.
    render(<ConfirmButton label="X" confirmLabel="Confirm: x" description="d" onConfirm={onConfirm} />);
    await userEvent.click(screen.getAllByRole("button", { name: "X" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("DataSourceBadge", () => {
  it("clearly distinguishes fixture data from service data and no-data", () => {
    const { rerender } = render(<DataSourceBadge source="fixture" />);
    expect(document.body.textContent).toMatch(/fixture · deterministic mock/i);
    rerender(<DataSourceBadge source="service" />);
    expect(document.body.textContent).toMatch(/service data/i);
    rerender(<DataSourceBadge source="none" />);
    expect(document.body.textContent).toMatch(/no data/i);
  });
});

describe("Timestamp", () => {
  it("renders absolute UTC and a relative suffix after mount", async () => {
    const iso = new Date(Date.now() - 90_000).toISOString();
    render(<Timestamp iso={iso} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/1m ago|2m ago/));
    expect(document.body.textContent).toMatch(/UTC/);
    const time = document.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(iso);
  });

  it("timeAgo bucketizes correctly", () => {
    expect(timeAgo(new Date(Date.now() - 5_000).toISOString())).toMatch(/s ago/);
    expect(timeAgo(new Date(Date.now() - 3 * 60_000).toISOString())).toBe("3m ago");
    expect(timeAgo(new Date(Date.now() - 5 * 3_600_000).toISOString())).toBe("5h ago");
  });
});
