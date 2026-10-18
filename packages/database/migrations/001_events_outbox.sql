-- Event outbox: durable record of every published event envelope.
create table if not exists events_outbox (
  event_id      uuid primary key,
  event_type    text not null,
  occurred_at   timestamptz not null,
  actor         jsonb not null,
  envelope      jsonb not null,
  created_at    timestamptz not null default now()
);

create index if not exists events_outbox_occurred_at_idx on events_outbox (occurred_at);
create index if not exists events_outbox_event_type_idx on events_outbox (event_type);
