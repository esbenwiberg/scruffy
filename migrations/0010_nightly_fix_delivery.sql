-- Gate 2 (nightly) FIX DELIVERY and RESOLUTION lifecycle: where a proposal was
-- delivered, what the repository's CI said about which commit, what a human did,
-- and whether the merged result was ever verified.
--
-- WHY. Migration 0008 gave a proposal three lifecycle axes (delivery/ci/merge) but
-- nowhere to record the FACTS those axes are derived from, and the outbox discarded
-- the provider's pull-request result entirely. Four gaps followed:
--
--  1. No PR handle. A stored `delivery = 'ready_open'` named no pull request, so
--     nothing could reconcile it, and a human had to go looking for the PR by hand.
--  2. No sha bound to the CI verdict. `ci = 'passed'` with no head sha is a claim
--     that survives a force-push: the proposal changes, the green verdict stays,
--     and a stale patch reads as validated. `ci_head_sha` makes the verdict
--     inseparable from the commit it was observed on.
--  3. No verification record. A merge is not a fix. Without somewhere to store
--     "checked the post-merge head at THIS sha and the defect was gone", the only
--     available shortcut was to treat merged as resolved.
--  4. No dismissal record. A human closing the child issue was indistinguishable
--     from Scruffy resolving it, which silently relabels a human's "won't fix" as
--     "verified fixed".
--
-- Append-only: migrations 0001..0009 are untouched.

-- 1. Delivery / CI / merge facts on the existing proposal row.
--
-- All nullable: a proposal that has not been delivered yet legitimately has none of
-- them, and inventing defaults would fabricate a PR or a CI verdict.
alter table nightly_fix_proposals
  -- The child work item (and therefore the child issue) this proposal remediates.
  -- Nullable for rows written before this migration; populated on every new commit.
  add column work_item_id      text references nightly_work_items(work_item_id) on delete set null,
  -- Reviewed identity, denormalised so reconciliation needs no join to know which
  -- immutable candidate the patch was anchored to.
  add column repository        text,
  add column base_branch       text,
  add column reviewed_head_sha text check (reviewed_head_sha ~ '^[0-9a-f]{40}$'),
  add column reviewed_base_sha text check (reviewed_base_sha ~ '^[0-9a-f]{40}$'),
  -- Provider PR handles. Stored together or not at all.
  add column pr_number         integer check (pr_number > 0),
  add column pr_url            text,
  add column pr_head_sha       text check (pr_head_sha ~ '^[0-9a-f]{40}$'),
  add column pr_draft          boolean,
  -- TERMINAL delivery failure (a refused patch, a colliding branch, a dead-lettered
  -- effect). Distinct from "not attempted yet", which is a null error with a
  -- 'queued' delivery.
  add column delivery_error    text,
  -- The commit the CI verdict in `ci` was observed on. See the pairing check below.
  add column ci_head_sha       text check (ci_head_sha ~ '^[0-9a-f]{40}$'),
  add column merge_commit_sha  text check (merge_commit_sha ~ '^[0-9a-f]{40}$'),
  add column merged_at         timestamptz,
  add column delivered_at      timestamptz;

alter table nightly_fix_proposals
  -- The four PR handles arrive together; a half-recorded PR cannot be reconciled.
  add constraint nightly_fix_proposals_pr_pairing
    check ((pr_number is null) = (pr_url is null)
       and (pr_number is null) = (pr_head_sha is null)
       and (pr_number is null) = (pr_draft is null)),
  -- THE STALE-GREEN GUARD. A verdict other than 'unknown' must name the commit it
  -- belongs to, and 'unknown' must not name one — so "we have no verdict for the
  -- current head" can never be stored as a verdict for some earlier head.
  add constraint nightly_fix_proposals_ci_sha_pairing
    check ((ci = 'unknown') = (ci_head_sha is null)),
  -- A delivery error is only meaningful on a failed delivery.
  add constraint nightly_fix_proposals_delivery_error_state
    check (delivery_error is null or delivery = 'delivery_failed'),
  -- Nothing is merged without a pull request to merge, and a merge commit only
  -- exists once merged.
  add constraint nightly_fix_proposals_merge_requires_pr
    check (merge_state = 'open' or pr_number is not null),
  add constraint nightly_fix_proposals_merge_commit_state
    check (merge_commit_sha is null or merge_state = 'merged');

comment on column nightly_fix_proposals.ci_head_sha is
  'Commit the CI verdict was observed on. Non-null exactly when ci <> ''unknown''; a new PR head resets both.';
comment on column nightly_fix_proposals.pr_head_sha is
  'PR head sha at the last observation. CI evidence is only current when it matches this.';

create index nightly_fix_proposals_reconcile_idx
  on nightly_fix_proposals (merge_state, updated_at)
  where pr_number is not null;

create index nightly_fix_proposals_work_item_idx on nightly_fix_proposals (work_item_id);

-- 2. Lifecycle history for a proposal, one row per axis transition.
--
-- Mirrors nightly_work_item_transitions (seq-unique so a replay re-inserts nothing)
-- and adds `evidence_sha`: the immutable commit the transition was justified by. A
-- CI transition with no evidence sha is not admissible, which is the same rule as
-- the column pairing above expressed as history rather than state.
create table nightly_fix_proposal_transitions (
  id           bigserial primary key,
  proposal_id  text not null references nightly_fix_proposals(proposal_id) on delete cascade,
  seq          integer not null,
  axis         text not null check (axis in ('delivery', 'ci', 'merge')),
  from_state   text,
  to_state     text not null,
  reason       text not null,
  evidence_sha text check (evidence_sha ~ '^[0-9a-f]{40}$'),
  at           timestamptz not null,
  unique (proposal_id, seq),
  check (axis <> 'ci' or evidence_sha is not null)
);

create index nightly_fix_proposal_transitions_proposal_idx
  on nightly_fix_proposal_transitions (proposal_id, seq);

-- 3. Post-merge verification of a finding.
--
-- Keyed on (occurrence_id, subject_sha) ON PURPOSE: a verification is only ever a
-- statement about ONE immutable commit. Keying on the occurrence alone would let a
-- verification of an older post-merge head satisfy a later one, which is the same
-- stale-evidence bug as carrying green CI across heads.
--
-- `indeterminate` is a stored outcome, not an absence: "the verifier could not read
-- the file" and "the defect is gone" must never collapse into the same row.
create table nightly_finding_verifications (
  occurrence_id text not null references nightly_report_findings(occurrence_id) on delete cascade,
  subject_sha   text not null check (subject_sha ~ '^[0-9a-f]{40}$'),
  outcome       text not null check (outcome in ('resolved', 'still_present', 'indeterminate')),
  detail        text not null,
  verifier_id   text not null,
  at            timestamptz not null,
  primary key (occurrence_id, subject_sha)
);

create index nightly_finding_verifications_occurrence_idx
  on nightly_finding_verifications (occurrence_id, at desc);

-- 4. External dismissal of a work item.
--
-- A human closing the child issue is an explicit decision with an author and a
-- reason where the provider gives us one. Recorded here rather than folded into
-- `resolution` so it can never be re-rendered as "Scruffy verified this fixed".
-- Both actor and reason stay nullable: GitHub omits `closed_by` in some flows, and
-- inventing an actor would fabricate an audit record.
alter table nightly_work_items
  add column dismissal_actor  text,
  add column dismissal_reason text,
  add column dismissed_at     timestamptz;

alter table nightly_work_items
  add constraint nightly_work_items_dismissal_pairing
    check (dismissed_at is not null or (dismissal_actor is null and dismissal_reason is null));

comment on column nightly_work_items.dismissed_at is
  'When a human closed this item outside Scruffy. An external dismissal is never relabelled as verified resolution.';
