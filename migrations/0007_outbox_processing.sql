-- Durable outbox claims. `for update skip locked` only holds a row for the
-- lifetime of the claiming transaction, which commits *before* the effect is
-- delivered — so two concurrent dispatchers could both claim the same row during
-- the delivery window and double-deliver it. claimPending now moves claimed rows
-- to a durable `processing` state stamped with `claimed_at`, which removes them
-- from the claimable set for the whole delivery window (not just the
-- transaction). markSent/markFailed settle only rows still in `processing`, and
-- rows stranded in `processing` past their lease (dead dispatcher) are reclaimed
-- on a later pass. This adds the `processing` status and the `claimed_at` lease
-- column the store now depends on.
alter table outbox
  drop constraint if exists outbox_status_check;

alter table outbox
  add constraint outbox_status_check check (status in ('pending', 'processing', 'sent', 'failed'));

alter table outbox
  add column claimed_at timestamptz;
