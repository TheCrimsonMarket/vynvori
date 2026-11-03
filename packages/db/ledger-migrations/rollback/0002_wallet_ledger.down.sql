-- ROLLBACK for 0002_wallet_ledger.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a disposable
-- database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while ANY row exists in wallets, ledger_commands, ledger_entries or ledger_grant_sources, and while a later
-- migration is journaled (roll those back first, in reverse order). The ledger is append-only (triggers reject DELETE), so
-- removing real ledger data means RESTORE FROM BACKUP, not running this script. One DO block: a failed guard can never be
-- followed by a surviving DROP even under plain `psql -f` without ON_ERROR_STOP.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0002_wallet_ledger.sql') THEN
    RAISE EXCEPTION '0002_wallet_ledger is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0002_wallet_ledger.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.wallets') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.ledger_commands') IS NULL
     OR pg_catalog.to_regclass('vynvori_ledger.ledger_entries') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.ledger_grant_sources') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0002 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.wallets, vynvori_ledger.ledger_commands, vynvori_ledger.ledger_grant_sources, vynvori_ledger.ledger_entries IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.ledger_entries) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_commands)
     OR EXISTS (SELECT 1 FROM vynvori_ledger.wallets) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_grant_sources) THEN
    RAISE EXCEPTION 'refusing rollback: rows exist in the ledger tables; ledger data is restored from backup, never deleted';
  END IF;
  DROP TABLE vynvori_ledger.ledger_entries;
  DROP TABLE vynvori_ledger.ledger_grant_sources;
  DROP TABLE vynvori_ledger.ledger_commands;
  DROP TABLE vynvori_ledger.wallets;
  DROP FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet();
  DROP FUNCTION vynvori_ledger.ledger_entries_check_command();
  DROP FUNCTION vynvori_ledger.wallets_update_guard();
  DROP FUNCTION vynvori_ledger.wallets_insert_guard();
  DROP FUNCTION vynvori_ledger.reject_mutation();
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0002_wallet_ledger.sql';
END
$rollback$;
