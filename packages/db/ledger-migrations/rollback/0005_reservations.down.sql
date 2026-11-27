-- ROLLBACK for 0005_reservations.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a disposable
-- database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while 0005 is not journaled, while a later migration is journaled (roll those back first, in reverse order), while
-- ANY row exists in ledger_authorizations, ledger_packages or credit_reservations, and while any non-grant ledger entry exists.
-- These tables are append-only or guarded (triggers reject DELETE/TRUNCATE), so removing real reservation data means RESTORE
-- FROM BACKUP, not running this script. It drops the ledger_entries reservation FK first, removes the S5 triggers on S2's and
-- S3's tables, and RE-ADDS S2's temporary ledger_entries_s2_grant_only constraint (ADR-0021 S2 addendum: "S5's rollback must
-- re-add it"). No GRANT; no CASCADE; no DELETE of ledger rows. One DO block: a failed guard can never be followed by a surviving
-- DROP even under plain `psql -f` without ON_ERROR_STOP. 0002's reject_mutation() is NOT dropped here: it is owned by 0002.
-- After an S9 re-own of ledger_entries_apply_to_reservation(), re-own it back to the migration owner first (as for 0002).
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0005_reservations.sql') THEN
    RAISE EXCEPTION '0005_reservations is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0005_reservations.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.ledger_authorizations') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.ledger_packages') IS NULL
     OR pg_catalog.to_regclass('vynvori_ledger.credit_reservations') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0005 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.ledger_entries, vynvori_ledger.ledger_quotes, vynvori_ledger.ledger_authorizations, vynvori_ledger.ledger_packages, vynvori_ledger.credit_reservations IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_packages)
     OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_authorizations) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_entries WHERE entry_kind <> 'grant') THEN
    RAISE EXCEPTION 'refusing rollback: rows exist in the reservation tables; ledger data is restored from backup, never deleted';
  END IF;
  DROP TRIGGER ledger_quotes_refuse_authorized_lineage ON vynvori_ledger.ledger_quotes;
  DROP TRIGGER ledger_entries_apply_to_reservation ON vynvori_ledger.ledger_entries;
  DROP TRIGGER ledger_entries_bind_reservation ON vynvori_ledger.ledger_entries;
  DROP INDEX vynvori_ledger.ledger_entries_one_terminal_per_reservation;
  ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_reservation_fk;
  ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s5_kinds;
  ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_s2_grant_only CHECK (entry_kind = 'grant');
  DROP TABLE vynvori_ledger.credit_reservations;
  DROP TABLE vynvori_ledger.ledger_packages;
  DROP TABLE vynvori_ledger.ledger_authorizations;
  DROP FUNCTION vynvori_ledger.ledger_quotes_refuse_authorized_lineage();
  DROP FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation();
  DROP FUNCTION vynvori_ledger.ledger_entries_bind_reservation();
  DROP FUNCTION vynvori_ledger.ledger_authorizations_check_complete();
  DROP FUNCTION vynvori_ledger.credit_reservations_check_not_pending();
  DROP FUNCTION vynvori_ledger.credit_reservations_update_guard();
  DROP FUNCTION vynvori_ledger.credit_reservations_check_insert();
  DROP FUNCTION vynvori_ledger.ledger_packages_check_insert();
  DROP FUNCTION vynvori_ledger.ledger_authorizations_check_insert();
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0005_reservations.sql';
END
$rollback$;
