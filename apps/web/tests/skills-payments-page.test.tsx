import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import PaymentsPage from "../app/payments/page";
import SkillsPage from "../app/skills/page";
import * as ui from "../components/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/payments" }));

const RECORDED = {
  paymentId: "11111111-1111-4111-8111-111111111111",
  agentId: "trend-scout-agent",
  chain: "base",
  asset: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0",
  amount: "1000000",
  status: "recorded",
  nonce: "22222222-2222-4222-8222-222222222222",
  grants: { contentAccess: true, trading: false },
  recordedAt: new Date().toISOString(),
};

const SETTLED = {
  paymentId: "33333333-3333-4333-8333-333333333333",
  agentId: "whale-tracking-agent",
  chain: "base",
  asset: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0",
  amount: "1000000",
  status: "settled",
  nonce: "44444444-4444-4444-8444-444444444444",
  transactionHash: "mock-tx-33333333",
  grants: { contentAccess: true, trading: false },
  recordedAt: new Date().toISOString(),
};

const REJECTED = {
  paymentId: "55555555-5555-4555-8555-555555555555",
  agentId: "trend-scout-agent",
  chain: "base",
  asset: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0",
  amount: "1000000",
  status: "rejected",
  rejectionCode: "recipient-not-allowed",
  nonce: "66666666-6666-4666-8666-666666666666",
  grants: { contentAccess: false, trading: false },
  recordedAt: new Date().toISOString(),
};

const PAYLOAD = {
  records: [RECORDED, SETTLED, REJECTED],
  reconcile: {
    ranAt: new Date().toISOString(),
    recordsChecked: 3,
    settledWithoutEvidence: [],
    duplicateNonces: [],
    consistent: true,
  },
  semantics: "a settled payment grants content access only",
};

describe("payments page (x402 guard)", () => {
  beforeEach(() => {
    vi.spyOn(ui, "getJson").mockImplementation(async () => PAYLOAD as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists payment records with statuses and content-only grants", async () => {
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByText("recorded")).toBeTruthy();
    expect(screen.getByText("settled")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();
    // Trading is never granted by any payment (the "never" is emphasized).
    expect(screen.getAllByText("never").length).toBe(3);
    expect(screen.getAllByText(/trading:/i).length).toBe(3);
    expect(screen.getByText(/ledger consistent/i)).toBeTruthy();
  });

  it("shows an honest empty state when the ledger has no records", async () => {
    vi.mocked(ui.getJson, true).mockImplementation(async () => ({ ...PAYLOAD, records: [], reconcile: { ...PAYLOAD.reconcile, recordsChecked: 0 } }) as never);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText(/no payments recorded/i)).toBeTruthy());
    expect(screen.getByText(/run the demo below/i)).toBeTruthy();
  });

  it("reports reconciliation problems when the ledger is inconsistent", async () => {
    vi.mocked(ui.getJson, true).mockImplementation(async () => ({ ...PAYLOAD, reconcile: { ...PAYLOAD.reconcile, settledWithoutEvidence: ["x"], duplicateNonces: ["y"], consistent: false } }) as never);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText(/inconsistencies detected/i)).toBeTruthy());
  });
});

describe("skills page (review-gated registry)", () => {
  beforeEach(() => {
    vi.spyOn(ui, "getJson").mockImplementation(async () =>
      ({
        skills: [
          {
            skillId: "demo-liquidity-snapshot",
            name: "Demo Liquidity Snapshot",
            version: "0.9.1",
            reviewStatus: "approved",
            testStatus: "untested",
            contentFlaggedSuspicious: false,
            isActive: true,
            declaredCapabilities: ["trend-analysis"],
          },
          {
            skillId: "evil-skill",
            name: "Evil Skill",
            version: "1.0.0",
            reviewStatus: "submitted",
            testStatus: "untested",
            contentFlaggedSuspicious: true,
            isActive: false,
            declaredCapabilities: ["trade-simulation"],
          },
        ],
      }) as never,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ agents: [] }) })) as never,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the registry with review states and content scans", async () => {
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getAllByRole("table").length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText(/demo-liquidity-snapshot@0\.9\.1/)).toBeTruthy();
    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByText("flagged")).toBeTruthy();
    // The lifecycle demo is gated: step buttons exist and start disabled appropriately.
    expect(screen.getByRole("button", { name: /1 · submit candidate/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /2 · approve/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /3 · install/i })).toBeTruthy();
  });

  it("shows the registry empty state before any submission", async () => {
    vi.mocked(ui.getJson, true).mockImplementation(async () => ({ skills: [] }) as never);
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getByText(/no skills submitted/i)).toBeTruthy());
    expect(screen.getByText(/submit → approve → install/i)).toBeTruthy();
  });
});
