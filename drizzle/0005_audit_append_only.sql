-- Append-only audit log.
--
-- The audit finding: "the log is mutable by anyone with database access ... an
-- audit trail that the audited party can rewrite is not evidence."
--
-- Application code cannot enforce this: the whole point is to constrain what
-- someone with a database connection can do, and any check in a service is
-- bypassed by connecting directly. So the rule lives in Postgres as a trigger,
-- which fires regardless of how the statement arrives.
--
-- UPDATE and DELETE are both refused outright. There is deliberately no
-- exception, not even for a superuser path in the application: a correction to
-- the log is made by appending a new row describing the correction, exactly as
-- a ledger correction is made by appending a reversal rather than editing
-- history.
--
-- Note this stops accidental and casual tampering, and makes deliberate
-- tampering require dropping the trigger — an act that is itself visible in the
-- schema and in Postgres's own logs. True tamper-*evidence* needs hash chaining
-- (each row signed against its predecessor), which is recorded as remaining
-- work rather than claimed here.

CREATE OR REPLACE FUNCTION audit_logs_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: % is not permitted. Record a corrective entry instead.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
