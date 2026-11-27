-- ROLLBACK for 0003_quotes.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a disposable
-- database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while ANY row exists in ledger_quote_lineages, ledger_quotes or ledger_quote_allocations, and while a later
-- migration is journaled (roll those back first, in reverse order). These tables are append-only (triggers reject
-- UPDATE/DELETE/TRUNCATE), so removing real quote data means RESTORE FROM BACKUP, not running this script.
-- No GRANT; the only REVOKE is function-level FROM PUBLIC; no SECURITY DEFINER. One DO block: a failed guard can never be
-- followed by a surviving DROP even under plain `psql -f` without ON_ERROR_STOP. 0002's reject_mutation() is NOT dropped
-- here: it is owned by 0002 and is still used by its own tables.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0003_quotes.sql') THEN
    RAISE EXCEPTION '0003_quotes is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0003_quotes.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.ledger_quote_lineages') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.ledger_quotes') IS NULL
     OR pg_catalog.to_regclass('vynvori_ledger.ledger_quote_allocations') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0003 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.ledger_quote_lineages, vynvori_ledger.ledger_quotes, vynvori_ledger.ledger_quote_allocations IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.ledger_quote_allocations) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_quotes)
     OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_quote_lineages) THEN
    RAISE EXCEPTION 'refusing rollback: rows exist in the quote tables; quote data is restored from backup, never deleted';
  END IF;
  DROP TABLE vynvori_ledger.ledger_quote_allocations;
  DROP TABLE vynvori_ledger.ledger_quotes;
  DROP TABLE vynvori_ledger.ledger_quote_lineages;
  DROP FUNCTION vynvori_ledger.ledger_quote_check_allocation_sums();
  DROP FUNCTION vynvori_ledger.ledger_quotes_check_version();
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0003_quotes.sql';
END
$rollback$;
