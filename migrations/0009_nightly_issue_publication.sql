-- Gate 2 (nightly) work-item ISSUE PUBLICATION: durable external references and
-- explicit effect dependencies.
--
-- WHY. Migration 0008 made the work graph durable but provider-neutral: it records
-- the INTENT to publish a parent and its children and nothing about where they
-- ended up. Two gaps followed from that.
--
--  1. The outbox discarded every provider write result. GitHub issues have no
--     `external_id` field, so a process that died between "GitHub created the
--     issue" and "we stored the number" left no local trace at all — and a child
--     cannot be attached to a parent whose number we never kept. Table 1 stores the
--     reference (and, just as importantly, a terminal failure to obtain one).
--  2. Child creation needs the parent's number; attachment needs both; the final
--     reconciliation needs every child settled. The outbox expressed none of that,
--     so correctness rested on row insertion order — which a retry, an expired
--     claim, or a partly-failed batch reorders freely. Tables 2/3 make the
--     dependency a declared fact the claim query enforces.
--
-- Append-only: migrations 0001..0008 are untouched.

-- 1. Where a work item was published, per provider.
--
-- The marker is stored even though it is derivable from `work_item_id`: it is the
-- record of WHICH marker format was used to publish, so a future format version can
-- still find issues published under the old one.
--
-- `publication_error` / `attachment_error` are TERMINAL failures (the effect was
-- dead-lettered), not transient retries. That distinction is load-bearing: a null
-- error with a null issue means "not attempted yet", which the parent issue and the
-- nightly check must render differently from "attempted and could not be filed".
create table nightly_work_item_publications (
  work_item_id       text primary key references nightly_work_items(work_item_id) on delete cascade,
  provider           text not null check (provider in ('github')),
  marker             text not null,
  -- Provider handles. Null until the issue exists.
  external_number    integer check (external_number > 0),
  external_id        text,
  external_url       text,
  attached_to_parent boolean not null default false,
  publication_error  text,
  attachment_error   text,
  published_at       timestamptz,
  attached_at        timestamptz,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  -- The three handles arrive together or not at all; a half-recorded reference
  -- cannot be used to attach a child or link a check.
  check ((external_number is null) = (external_id is null)),
  check ((external_number is null) = (external_url is null)),
  -- A published item and a terminal publication failure are contradictory claims
  -- about the same attempt. Refuse to store both (mirrors WorkItemPublication).
  check (external_id is null or publication_error is null),
  check (not attached_to_parent or attachment_error is null),
  -- Nothing can be attached without an issue to attach.
  check (not attached_to_parent or external_id is not null)
);

comment on table nightly_work_item_publications is
  'Where each nightly work item was published. Publication FACT; nightly_work_items is publication INTENT.';

-- 2. What an outbox effect makes available to dependent effects.
--
-- Nullable because check_run/pull_request effects produce nothing another effect
-- waits on; only the issue effects do.
-- `on delete cascade`, not the default NO ACTION: `nightly_reports` cascades to
-- `nightly_work_items`, so a NO ACTION reference from `outbox` would make deleting a
-- report fail outright and take every retention/purge path with it. An effect whose
-- work item no longer exists has nothing to publish, so removing the row is also the
-- correct answer on its own terms. Cascading the whole row (rather than nulling the
-- column) is what keeps `outbox_produces_pairing` satisfiable.
alter table outbox
  add column produces_work_item_id text references nightly_work_items(work_item_id) on delete cascade,
  add column produces              text check (produces in ('issue_reference', 'attachment'));

alter table outbox
  add constraint outbox_produces_pairing check ((produces_work_item_id is null) = (produces is null));

-- 3. What an outbox effect needs before it can be delivered.
--
-- `requires` semantics (see EffectDependencyKind):
--   issue_reference      the work item's issue must EXIST (a terminal publication
--                        failure makes this permanently unsatisfiable, so dependents
--                        are cascaded to a terminal failure rather than waiting);
--   publication_settled  publication reached a terminal outcome, success OR failure;
--   attachment_settled   attachment reached a terminal outcome, or there was never
--                        an issue to attach.
create table outbox_dependencies (
  outbox_id             text not null references outbox(id) on delete cascade,
  requires_work_item_id text not null references nightly_work_items(work_item_id) on delete cascade,
  requires              text not null check (requires in ('issue_reference', 'publication_settled', 'attachment_settled')),
  primary key (outbox_id, requires_work_item_id, requires)
);

create index outbox_dependencies_work_item_idx on outbox_dependencies (requires_work_item_id);
