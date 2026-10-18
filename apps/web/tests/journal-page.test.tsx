import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JournalPage from "../app/journal/page";
import * as ui from "../components/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/journal" }));

const FILLED = {
  receiptId: "11111111-1111-4111-8111-111111111111",
  intentId: "22222222-2222-4222-8222-222222222222",
  authorizationId: "33333333-3333-4333-8333-333333333333",
  status: "paper-filled",
  executionMode: "paper",
  paperTxHash: "paper-abcdef0123456789",
  feeUsdCents: 12,
  decidedAt: new Date().toISOString(),
  guardPipelineVersion: "0.1.0",
};

const REJECTED = {
  receiptId: "44444444-4444-4444-8444-444444444444",
  intentId: "55555555-5555-4555-8555-555555555555",
  authorizationId: "66666666-6666-4666-8666-666666666666",
  status: "rejected",
  executionMode: "paper",
  rejectionCode: "expired-authorization",
  rejectionDetail: "authorization expired at 2026-02-01T00:01:00.000Z",
  decidedAt: new Date().toISOString(),
  guardPipelineVersion: "0.1.0",
};

describe("journal page (guarded execution receipts)", () => {
  beforeEach(() => {
    vi.spyOn(ui, "getJson").mockImplementation(async () =>
      ({ receipts: [FILLED, REJECTED] }) as never,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("lists paper receipts with outcomes and authorization status", async () => {
    render(<JournalPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByText("paper-filled")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(screen.getByText("expired-authorization")).toBeTruthy();
    expect(screen.getAllByText(/consumed/i).length).toBeGreaterThan(0);
  });

  it("filters to rejected receipts only", async () => {
    render(<JournalPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /rejected only/i }));
    await waitFor(() => expect(screen.queryByText("paper-filled")).toBeNull());
    expect(screen.getByText("expired-authorization")).toBeTruthy();
  });

  it("shows an honest empty state when there are no receipts", async () => {
    vi.mocked(ui.getJson, true).mockImplementation(async () => ({ receipts: [] }) as never);
    render(<JournalPage />);
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeTruthy());
    expect(screen.getByText(/execution safety page/i)).toBeTruthy();
  });
});
