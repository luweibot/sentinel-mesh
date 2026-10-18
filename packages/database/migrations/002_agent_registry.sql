-- Agent registry: manifests are stored as validated JSONB documents.
create table if not exists agents (
  agent_id      text primary key,
  version       text not null,
  manifest      jsonb not null,
  registered_at timestamptz not null default now()
);
