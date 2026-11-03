-- ROLLBACK for 0001_ledger_schema.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a
-- disposable database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while ANY relation exists in vynvori_ledger, so a rollback can never silently destroy ledger data. Because
-- later ledger tables are append-only (triggers reject DELETE), removing real ledger data means RESTORE FROM BACKUP,
-- not running this script. The guard and both DROPs are ONE statement, so a failed guard can never be followed by a
-- surviving DROP even under plain `psql -f` without ON_ERROR_STOP. No CASCADE on vynvori_ledger: functions, types or
-- other objects there also make the DROP fail. The journal schema is removed so up -> down -> up passes the drift check.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF to_regnamespace('vynvori_ledger') IS NULL THEN RAISE EXCEPTION 'schema not present'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'vynvori_ledger') THEN
    RAISE EXCEPTION 'refusing rollback: relations exist in vynvori_ledger; later migrations must be rolled back first, and ledger data is restored from backup';
  END IF;
  DROP SCHEMA vynvori_ledger;
  DROP SCHEMA vynvori_ledger_migrations CASCADE;
END
$rollback$;
