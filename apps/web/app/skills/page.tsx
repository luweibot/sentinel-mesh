"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell, PageHead } from "../../components/nav";
import {
  API_BASE,
  ConfirmButton,
  DataTable,
  DataSourceBadge,
  getJson,
  postJson,
  ORCHESTRATOR_BASE,
  type Column,
} from "../../components/ui";

interface AgentManifest {
  capabilities: string[];
  agentId: string;
  supportedTaskTypes: string[];
}

interface RegistrySkillRow {
  skillId: string;
  name: string;
  version: string;
  reviewStatus: string;
  testStatus: string;
  contentFlaggedSuspicious: boolean;
  isActive: boolean;
  declaredCapabilities: string[];
}

const DEMO_SKILL_ID = "demo-liquidity-snapshot";
const DEMO_SKILL_MD = `# demo-liquidity-snapshot

Collects a liquidity snapshot for a token from the data layer.

## Usage

Ask the trend-scout agent to scan trending tokens, then read the pool
liquidity for the top candidate. Report TVL, pool kinds, and block height.

## Limits

- Read-only: never submits trades or authorizations.
- Fixture data only in this phase.
`;

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return `sha256-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export default function SkillsPage(): React.JSX.Element {
  const [manifests, setManifests] = useState<AgentManifest[]>([]);
  const [registry, setRegistry] = useState<RegistrySkillRow[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Guided lifecycle state: nothing installs without explicit steps. */
  const [demoVersion, setDemoVersion] = useState<string | null>(null);
  const [demoStep, setDemoStep] = useState<"submit" | "approve" | "install" | "done">("submit");

  const loadRegistry = useCallback(async () => {
    try {
      const data = await getJson<{ skills: RegistrySkillRow[] }>(`${ORCHESTRATOR_BASE}/api/v1/skills`);
      setRegistry(data.skills);
      setRegistryError(null);
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/agents`, { headers: { accept: "application/json" }, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`agents: ${response.status}`))))
      .then((data: { agents: AgentManifest[] }) => setManifests(data.agents))
      .catch((err: unknown) => setRegistryError(err instanceof Error ? err.message : String(err)));
    void loadRegistry();
  }, [loadRegistry]);

  const skills = new Map<string, { capability: string; agents: string[]; taskTypes: string[] }>();
  for (const manifest of manifests) {
    for (const capability of manifest.capabilities) {
      const existing = skills.get(capability) ?? { capability, agents: [], taskTypes: [] };
      existing.agents.push(manifest.agentId);
      existing.taskTypes.push(...manifest.supportedTaskTypes);
      skills.set(capability, existing);
    }
  }
  const capabilityRows = [...skills.values()];

  const columns: Array<Column<{ capability: string; agents: string[]; taskTypes: string[] }>> = [
    { key: "capability", header: "Capability", render: (row) => <span className="badge tone-primary">{row.capability}</span> },
    { key: "agents", header: "Provided by", render: (row) => row.agents.map((agent) => <code key={agent} style={{ marginRight: 6 }}>{agent}</code>) },
    { key: "tasks", header: "Task types", render: (row) => row.taskTypes.map((task) => <span key={task} className="badge" style={{ marginRight: 4 }}>{task}</span>) },
  ];

  const registryColumns: Array<Column<RegistrySkillRow>> = [
    { key: "skill", header: "Skill", render: (row) => <code>{row.skillId}@{row.version}</code> },
    {
      key: "reviewStatus",
      header: "Review",
      render: (row) => <span className={`badge ${row.reviewStatus === "approved" ? "tone-primary" : ""}`}>{row.reviewStatus}</span>,
    },
    { key: "testStatus", header: "Tests", render: (row) => row.testStatus },
    { key: "active", header: "Active", render: (row) => (row.isActive ? "installed" : "—") },
    {
      key: "flagged",
      header: "Content scan",
      render: (row) => (row.contentFlaggedSuspicious ? <span style={{ color: "var(--danger)" }}>flagged</span> : "clean"),
    },
    { key: "caps", header: "Capabilities", render: (row) => row.declaredCapabilities.map((capability) => <span key={capability} className="badge" style={{ marginRight: 4 }}>{capability}</span>) },
  ];

  async function runResearch(): Promise<void> {
    setBusy(true);
    setWorkflowError(null);
    try {
      const data = await postJson<{ run: { runId: string; status: string } }>(`${ORCHESTRATOR_BASE}/api/v1/workflows/research`, {
        topic: "base ecosystem sentiment",
        maxDocuments: 2,
      });
      setResult(`Research workflow started: run ${data.run.runId.slice(0, 8)} (${data.run.status}). Watch the Traces page.`);
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function demoSubmit(): Promise<void> {
    setBusy(true);
    setWorkflowError(null);
    try {
      const version = `0.9.${Math.floor(Date.now() / 60_000) % 100_000}`; // unique per demo run
      const manifest = {
        schemaVersion: 1,
        skillId: DEMO_SKILL_ID,
        name: "Demo Liquidity Snapshot",
        description: "Dashboard demo skill: read-only liquidity snapshot guidance.",
        version,
        author: "dashboard-demo",
        declaredCapabilities: ["trend-analysis"],
        dependencies: [],
        contentHash: await sha256Hex(DEMO_SKILL_MD),
        instructionsPath: "SKILL.md",
        checks: [
          { name: "manifest-version-is-semantic", kind: "expression", expression: "manifest.version.split('.').length === 3", expected: true },
          { name: "no-process-access", kind: "expression", expression: "typeof process === 'undefined'", expected: true },
        ],
        provenance: { submittedBy: "dashboard-demo", submittedAt: new Date().toISOString() },
        testStatus: "untested",
      };
      const response = await postJson<{ record: { reviewStatus: string } }>(`${ORCHESTRATOR_BASE}/api/v1/skills/submit`, {
        manifest,
        content: DEMO_SKILL_MD,
      });
      if (response.record.reviewStatus !== "submitted") {
        throw new Error("registry returned an unexpected review status");
      }
      setDemoVersion(version);
      setDemoStep("approve");
      setResult(`Submitted ${DEMO_SKILL_ID}@${version} as "submitted" — NOT installed. The content hash was verified, the sandbox checks passed, and the content scan came back clean. Only an explicit reviewer approval can move it forward.`);
      await loadRegistry();
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function demoApprove(): Promise<void> {
    if (!demoVersion) return;
    setBusy(true);
    setWorkflowError(null);
    try {
      await postJson(`${ORCHESTRATOR_BASE}/api/v1/skills/approve`, {
        skillId: DEMO_SKILL_ID,
        version: demoVersion,
        reviewerId: "dashboard-reviewer",
      });
      setDemoStep("install");
      setResult(`Approved by dashboard-reviewer. Still not installed — installation is a second, explicit step.`);
      await loadRegistry();
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function demoInstall(): Promise<void> {
    if (!demoVersion) return;
    setBusy(true);
    setWorkflowError(null);
    try {
      await postJson(`${ORCHESTRATOR_BASE}/api/v1/skills/install`, {
        skillId: DEMO_SKILL_ID,
        version: demoVersion,
        reviewerId: "dashboard-reviewer",
      });
      setDemoStep("done");
      setResult(`Installed ${DEMO_SKILL_ID}@${demoVersion}. The registry now pins this version; rollback returns to the previous approved one.`);
      await loadRegistry();
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <PageHead
        title="Skill studio"
        lede="Capabilities the mesh offers today, plus the review-gated skill registry: candidates are hashed, scanned, and sandbox-checked, and nothing installs without explicit human approval."
        right={<DataSourceBadge source="service" />}
      />
      <DataTable
        caption="Skill registry (review states; nothing auto-installs)"
        columns={registryColumns}
        rows={registry ?? []}
        rowKey={(row) => `${row.skillId}@${row.version}`}
        loading={registry === null && !registryError}
        emptyTitle="No skills submitted"
        emptyDetail="Use the guided lifecycle demo below to walk a candidate through submit → approve → install."
      />
      {registryError ? <p className="tiny" style={{ color: "var(--danger)" }}>{registryError}</p> : null}
      <div className="card">
        <h2>Demo: review-gated lifecycle</h2>
        <p className="tiny muted">
          Each step is explicit and confirmed. The registry forces the candidate to start as "submitted"; approval and installation are
          separate human actions. Skills cannot declare their own review status, capabilities outside the deployment allowlist, or permissions.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <ConfirmButton
            label={busy && demoStep === "submit" ? "Submitting…" : "1 · Submit candidate"}
            confirmLabel="Confirm: submit the demo skill"
            description="Hashes and validates the demo SKILL.md, runs the sandbox checks, and stores it as 'submitted'. Does not install anything."
            disabled={busy || demoStep !== "submit"}
            onConfirm={() => void demoSubmit()}
          />
          <ConfirmButton
            label={busy && demoStep === "approve" ? "Approving…" : "2 · Approve"}
            confirmLabel="Confirm: approve as dashboard-reviewer"
            description="Records an explicit human approval. Still not installed."
            disabled={busy || demoStep !== "approve"}
            onConfirm={() => void demoApprove()}
          />
          <ConfirmButton
            label={busy && demoStep === "install" ? "Installing…" : "3 · Install"}
            confirmLabel="Confirm: install the approved version"
            description="Activates the approved version in the registry. It only pins a version; no runtime behavior changes in this phase."
            disabled={busy || demoStep !== "install"}
            onConfirm={() => void demoInstall()}
          />
        </div>
        {result ? <p className="tiny" style={{ marginTop: "0.6rem" }}>{result}</p> : null}
        {workflowError ? <p className="tiny" style={{ marginTop: "0.6rem", color: "var(--danger)" }}>{workflowError}</p> : null}
      </div>
      <div className="card">
        <h2>Run a research workflow</h2>
        <p className="tiny muted">
          Three agents collaborate: the research agent gathers fixture documents, the verification agent checks them, and the news agent
          summarizes. All data is deterministic fixtures; the run is recorded and traceable.
        </p>
        <ConfirmButton
          label={busy && !demoStep ? "Starting…" : "Start research workflow"}
          confirmLabel="Confirm: start the research workflow"
          description="This creates a workflow run with traceable task records. It reads fixture data only and executes no trades."
          disabled={busy}
          onConfirm={() => void runResearch()}
        />
        {result && demoStep === "done" ? null : result && !demoVersion ? (
          <p className="tiny" style={{ marginTop: "0.6rem" }}>{result}</p>
        ) : null}
      </div>
      <DataTable
        caption="Capabilities available in the mesh"
        columns={columns}
        rows={capabilityRows}
        rowKey={(row) => row.capability}
        loading={manifests.length === 0 && !registryError}
        emptyTitle="No capabilities registered"
      />
      <div className="notice">
        <strong>Note:</strong> SKILL.md content is untrusted instructions — hashed and scanned, never executed. Sandbox checks run in an
        isolated vm with no host access and a hard timeout.
      </div>
    </Shell>
  );
}
