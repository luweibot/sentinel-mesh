-- Durable workflow state.
create table if not exists workflow_runs (
  run_id         uuid primary key,
  workflow_name  text not null,
  status         text not null check (status in ('pending','running','waiting','completed','failed','cancelled')),
  input          jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create table if not exists workflow_steps (
  run_id      uuid not null references workflow_runs (run_id) on delete cascade,
  step_id     text not null,
  name        text not null,
  status      text not null check (status in ('pending','running','waiting','succeeded','failed','skipped','cancelled')),
  started_at  timestamptz,
  finished_at timestamptz,
  output      jsonb,
  error       jsonb,
  primary key (run_id, step_id)
);

create index if not exists workflow_runs_status_idx on workflow_runs (status);
