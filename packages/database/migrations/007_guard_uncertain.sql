-- Uncertain live broadcasts (audit 2026-10-21).
--
-- SECURITY: a live broadcast that neither confirmed nor definitively
-- failed may STILL LAND onchain. The pre-fix executor aborted the
-- in-flight idempotency lock on "execution-uncertain", so an identical
-- resubmission could broadcast a SECOND transaction while the first was
-- pending. Uncertain broadcasts are now journaled here: the in-flight
-- lock and the cap reservation survive a restart (restore() keeps these
-- rows; cap reservations persist as released=false guard_fills rows) and
-- ONLY the explicit operator resolution after onchain reconciliation
-- (POST /api/v1/execution/uncertain/resolve) may release them.
create table if not exists guard_uncertain (
  intent_id   text primary key,
  intent_hash text not null,
  payload     jsonb not null,
  recorded_at timestamptz not null default now()
);
