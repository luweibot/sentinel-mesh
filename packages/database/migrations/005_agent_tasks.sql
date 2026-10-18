-- Agent orchestration: durable task storage, processed-event bookkeeping,
-- and durable workflow run documents.
create table if not exists agent_tasks (
  task_id          uuid primary key,
  agent_id         text not null,
  task_type        text not null,
  status           text not null check (status in ('pending','running','retry-scheduled','succeeded','failed','cancelled')),
  attempt_executed integer not null default 0,
  idempotency_key  text,
  workflow_run_id  uuid,
  deadline_at      timestamptz,
  retry_at         timestamptz,
  task             jsonb not null,
  result           jsonb,
  issued_at        timestamptz not null,
  updated_at       timestamptz not null default now()
);

create index if not exists agent_tasks_status_idx on agent_tasks (status);
create index if not exists agent_tasks_workflow_run_idx on agent_tasks (workflow_run_id);
create index if not exists agent_tasks_idempotency_idx on agent_tasks (idempotency_key);

create table if not exists processed_events (
  event_id     uuid not null,
  consumer     text not null,
  processed_at timestamptz not null default now(),
  primary key (event_id, consumer)
);

create table if not exists workflow_run_documents (
  run_id         uuid primary key,
  workflow_name  text not null,
  document       jsonb not null,
  updated_at     timestamptz not null default now()
);
