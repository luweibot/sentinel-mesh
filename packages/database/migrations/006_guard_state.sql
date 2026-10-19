-- Guard-state durability (sleep/wake safety on free-tier compute).
--
-- SECURITY (audit 2026-10-19): the guarded execution pipeline keeps its
-- runtime state in process memory for synchronous, single-process race
-- protection (see audit 2026-10-18). On hosts whose instances sleep, a
-- restart used to silently reset that state: completed intents could be
-- re-executed, spend caps forgot their fills, and an ENGAGED kill switch
-- was lost on restart. These tables journal the same facts so the
-- orchestrator restores guard state at boot, before serving traffic.

-- Paper receipts (fills and rejections) — restores the reconciliation
-- ledger and powers idempotent replay of completed intents.
create table if not exists guard_receipts (
  receipt_id  uuid primary key,
  intent_id   text not null,
  payload     jsonb not null,
  recorded_at timestamptz not null default now()
);
create index if not exists guard_receipts_intent_idx on guard_receipts (intent_id);

-- Idempotency registry entries. Only 'recorded' rows are restored after a
-- restart: an in-flight row means the process died before committing, so
-- no receipt exists and the intent may be resubmitted (fail-safe:
-- restore() deletes in-flight rows).
create table if not exists guard_idempotency (
  intent_id   text primary key,
  intent_hash text not null,
  status      text not null check (status in ('in-flight','recorded')),
  receipt_id  uuid
);

-- Limit-store fills (cap reservations that become committed notional).
-- A released reservation keeps its row with released=true; restore loads
-- only released=false rows. Restored fills without a matching receipt are
-- counted CONSERVATIVELY against the caps (crash between the in-memory
-- reservation and the receipt commit never frees cap space silently).
create table if not exists guard_fills (
  fill_id            uuid primary key,
  user_id            text not null,
  strategy_id        text not null,
  chain              text not null,
  notional_usd_cents bigint not null,
  pnl_usd_cents      bigint not null,
  day                text not null,
  released           boolean not null default false,
  recorded_at        timestamptz not null default now()
);
create index if not exists guard_fills_user_day_idx on guard_fills (user_id, day);
create index if not exists guard_fills_strategy_day_idx on guard_fills (strategy_id, day);

-- Kill-switch states. scope is 'global' | 'user:<id>' | 'strategy:<id>'.
-- A missing 'global' row restores as UNKNOWN (fail closed): after every
-- deploy an operator must explicitly clear the switch; an engaged switch
-- can never be lost to a restart.
create table if not exists guard_kill_switch (
  scope text primary key,
  state text not null check (state in ('clear','engaged','unknown'))
);

-- x402 per-agent daily spend-cap utilization (mock payments phase).
create table if not exists guard_spend_caps (
  agent_id            text not null,
  day                 text not null,
  committed_usd_cents bigint not null default 0,
  reserved_usd_cents  bigint not null default 0,
  primary key (agent_id, day)
);
