-- Guarded-trading pipeline state: signals and their policy decisions.
create table if not exists signals (
  signal_id         uuid primary key,
  chain             text not null,
  kind              text not null check (kind in ('copy-trade','trend-entry','manual')),
  token_in          text not null,
  token_out         text not null,
  notional_usd_cents integer not null check (notional_usd_cents > 0),
  source_wallet     text,
  created_at        timestamptz not null default now()
);

create table if not exists policy_decisions (
  decision_id     uuid primary key,
  signal_id       uuid not null references signals (signal_id) on delete cascade,
  verdict         text not null check (verdict in ('allow','reject','requires-review')),
  -- Phase 0 guard: the schema itself only permits simulation mode.
  execution_mode  text not null check (execution_mode = 'simulation'),
  reasons         jsonb not null,
  policy_version  text not null,
  evaluated_at    timestamptz not null
);

create index if not exists policy_decisions_signal_idx on policy_decisions (signal_id);
