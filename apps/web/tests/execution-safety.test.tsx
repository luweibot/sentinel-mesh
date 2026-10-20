import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExecutionPage from "../app/execution/page";
import AgentsPage from "../app/agents/page";
import { SiteNav } from "../components/nav";
import * as ui from "../components/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/execution" }));

function mockFetchJson(responder: (url: string) => unknown): void {
  vi.spyOn(ui, "getJson").mockImplementation(async (url: string) => responder(String(url)) as never);
}

describe("execution safety page", () => {
  beforeEach(() => {
    mockFetchJson((url) => {
      if (url.includes("/execution/kill-switch")) {
        return { snapshot: { global: "clear", users: {}, strategies: {} }, semantics: "fail closed" };
      }
      if (url.includes("/execution/reconcile")) {
        return { report: { ranAt: new Date().toISOString(), receiptsChecked: 2, missingReceipts: [], duplicateReceipts: [], mismatches: [], consistent: true } };
      }
      throw new Error(`unexpected url ${url}`);
    });
  });

  it("shows the kill-switch state and reconciliation verdict", async () => {
    render(<ExecutionPage />);
    await waitFor(() => expect(screen.getByText(/consistent/i)).toBeTruthy());
    expect(screen.getByText("clear")).toBeTruthy();
    expect(screen.getByText(/receipts checked/i)).toBeTruthy();
  });

  it("minting an authorization displays its status and expiry", async () => {
    const auth = { authorizationId: "77777777-7777-4777-8777-777777777777", status: "active", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    vi.spyOn(ui, "postJson").mockImplementation(async () => ({ authorization: auth }) as never);
    render(<ExecutionPage />);
    await userEvent.click(screen.getByRole("button", { name: /mint demo authorization/i }));
    await waitFor(() => expect(screen.getByText(/Authorization status/i)).toBeTruthy());
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("submitting requires explicit confirmation and shows the typed receipt", async () => {
    const receipt = {
      receiptId: "88888888-8888-4888-8888-888888888888",
      intentId: "99999999-9999-4999-8999-999999999999",
      status: "paper-filled",
      decidedAt: new Date().toISOString(),
      guardPipelineVersion: "0.1.0",
      authorizationId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
    };
    vi.spyOn(ui, "postJson").mockImplementation(async (url: string) => {
      if (String(url).includes("/authorizations")) {
        return { authorization: { authorizationId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa", status: "active", expiresAt: new Date().toISOString() } } as never;
      }
      if (String(url).includes("/intents")) {
        return { receipt } as never;
      }
      throw new Error("unexpected post");
    });
    render(<ExecutionPage />);
    await userEvent.click(screen.getByRole("button", { name: /submit authorized intent/i }));
    // Second step: explicit confirm.
    await userEvent.click(screen.getByRole("button", { name: /confirm: submit this intent/i }));
    await waitFor(() => expect(screen.getByText("paper-filled")).toBeTruthy());
  });
});

describe("agent registry page", () => {
  it("renders all registered agents and capability filters work", async () => {
    mockFetchJson((url) => {
      if (String(url).includes("/api/v1/agents")) {
        return {
          agents: [
            { agentId: "paper-trade-agent", displayName: "Paper Trading Agent", version: "0.1.0", capabilities: ["paper-trading"], supportedTaskTypes: ["paper-trade"], permissions: { networkAccess: "mock", canSignTransactions: false }, chainAffinity: ["base"] },
            { agentId: "token-risk-agent", displayName: "Token Risk Agent", version: "0.1.0", capabilities: ["research"], supportedTaskTypes: ["scan-trending"], permissions: { networkAccess: "none", canSignTransactions: false }, chainAffinity: ["base"] },
          ],
          total: 2,
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
    render(<AgentsPage />);
    await waitFor(() => expect(screen.getByRole("table", { name: /registered agents/i })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "paper-trading" }));
    await waitFor(() => expect(screen.getByText(/of \d+ registered agents/)).toBeTruthy());
    // The paper-trade agent is present in the registry.
    expect(screen.getByText(/Paper Trading Agent/i)).toBeTruthy();
  });
});

describe("mobile navigation", () => {
  it("the menu is hidden on mobile until the disclosure toggle opens it", async () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    render(<SiteNav />);
    const nav = document.getElementById("primary-nav");
    expect(nav?.hasAttribute("hidden")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(nav?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("button", { name: /menu/i }).getAttribute("aria-expanded")).toBe("true");
  });
});
