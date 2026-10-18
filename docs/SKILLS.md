# Skill Registry and Sandbox

Skills are installable capability modules: a manifest plus a `SKILL.md`
instruction file. The registry treats BOTH as untrusted input. The security
model, in one sentence: **a skill can never make itself installed, reviewed,
privileged, or executed.**

## Threat model

- `SKILL.md` content is **untrusted instructions**. It is hashed and scanned,
  never executed, never parsed for permissions.
- The manifest is validated by a STRICT schema: any injected key
  (`permissions`, `reviewStatus`, `autoInstall`, ...) makes the parse FAIL
  (intake returns `SKILL_INTAKE_REJECTED`). Skills cannot smuggle state or
  self-approve.
- `declaredCapabilities` must be a subset of the DEPLOYMENT allowlist
  (`SKILL_CAPABILITY_ALLOWLIST` in `apps/orchestrator/src/skills-payments.ts`).
  That allowlist deliberately excludes `trade-simulation`,
  `signal-generation`, and `paper-trading`: skills extend intelligence,
  never execution.
- Sandbox checks (`kind: "expression"`) are UNTRUSTED CODE. They run in a
  `node:vm` context with no host access (`process`, `require`, `fetch`,
  `globalThis` are absent or inert), a 50 ms timeout, and a result-size
  cap. A throwing or timing-out check FAILS the validation (fail closed).

## Lifecycle (each step is explicit)

```
submit (status: submitted, NOT active)
  └─ approve(skillId, version, reviewerId)   → approved   (human action)
       └─ install(skillId, version, reviewerId) → active  (human action)
            └─ rollback(skillId, reviewerId)  → previous approved version
```

- Intake verifies the manifest schema, the `contentHash` (sha256 of
  `SKILL.md`), the capability allowlist, dependency availability, and runs
  the sandbox checks. Any failure is recorded as an issue; the record is
  still stored (audit trail of malicious submissions) but approval is
  refused while error issues exist.
- Content is scanned for injection patterns ("ignore previous
  instructions", "change your permissions", "reveal your system prompt",
  "run shell commands", ...). Flagged content blocks approval permanently.
- Versions are pinned; duplicate submissions of the same version are
  refused. Rollback reinstates the previous approved version and is
  recorded in the registry history.

## API (orchestrator service)

| Method | Path | Semantics |
|---|---|---|
| GET | `/api/v1/skills` | registry listing: review states, active flags, content scan results |
| POST | `/api/v1/skills/submit` | intake (never installs); 422 `SKILL_INTAKE_REJECTED` on strict-schema failures |
| POST | `/api/v1/skills/approve` | explicit human approval; 409 while validation issues remain |
| POST | `/api/v1/skills/reject` | explicit human rejection with a reason |
| POST | `/api/v1/skills/install` | activates an APPROVED version only; 409 otherwise |
| POST | `/api/v1/skills/rollback` | returns to the previous approved version |

## Storage

In-memory for this phase (documented in `docs/LIMITATIONS.md`): the
registry resets on restart. Persisting records requires a migration and an
ADR; no runtime behavior depends on persistence for safety — every guard
is stateless with respect to its inputs.

## Verification

`packages/skills` ships 10 tests covering: happy-path lifecycle, hash
tampering, capability allowlist, injected-key rejection, sandbox isolation
(no `process`, no `require`, hostile expressions fail closed), duplicate
versions, suspicious-content approval blocking, and rollback.
