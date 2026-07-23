-- Dead-lettering for outbox effects. A `check_run` write is idempotent and
-- retryable, but some effects fail permanently (unknown effect type, a payload
-- that no longer parses, or a write the adapter refuses). Without a terminal
-- state such an effect is re-claimed on every dispatch pass forever, and — worse
-- — before per-record error isolation it could abort the whole batch and starve
-- every effect behind it. `failed` is that terminal state; `last_error` records
-- why for the operator.
alter table outbox
  drop constraint if exists outbox_status_check;

alter table outbox
  add constraint outbox_status_check check (status in ('pending', 'sent', 'failed'));

alter table outbox
  add column last_error text;
