-- ROLLBACK for 0007_refinement_slots.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a disposable
-- database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while 0007 is not journaled, while a later migration is journaled (roll those back first, in reverse order), while ANY
-- row exists in ledger_package_events, refinement_slots or refinement_slot_events, and while any bundle package is no longer in its
-- born state `authorized` (a package that moved without an event row would be drift; a package that moved with one is covered by the
-- row check). These tables are append-only or guarded (triggers reject DELETE/TRUNCATE), so removing real package or slot history
-- means RESTORE FROM BACKUP, not running this script. It restores S5's `ledger_packages_immutable` trigger (every UPDATE rejected)
-- and drops only 0007's own objects. No GRANT; no CASCADE; no DELETE of ledger rows. One DO block: a failed guard can never be
-- followed by a surviving DROP even under plain `psql -f` without ON_ERROR_STOP. 0002's reject_mutation() is NOT dropped here.
-- After an S9 re-own of ledger_package_events_apply() or refinement_slot_events_apply(), re-own each back to the migration owner first.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0007_refinement_slots.sql') THEN
    RAISE EXCEPTION '0007_refinement_slots is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0007_refinement_slots.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.ledger_package_events') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.refinement_slots') IS NULL
     OR pg_catalog.to_regclass('vynvori_ledger.refinement_slot_events') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.ledger_packages') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0007 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.ledger_packages, vynvori_ledger.ledger_package_events, vynvori_ledger.refinement_slots, vynvori_ledger.refinement_slot_events IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.ledger_package_events) OR EXISTS (SELECT 1 FROM vynvori_ledger.refinement_slots)
     OR EXISTS (SELECT 1 FROM vynvori_ledger.refinement_slot_events) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_packages WHERE state <> 'authorized') THEN
    RAISE EXCEPTION 'refusing rollback: package events, refinement slots or moved packages exist; this history is restored from backup, never deleted';
  END IF;
  DROP TRIGGER ledger_packages_update_guard ON vynvori_ledger.ledger_packages;
  DROP TRIGGER ledger_packages_no_delete ON vynvori_ledger.ledger_packages;
  CREATE TRIGGER ledger_packages_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_packages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
  DROP TABLE vynvori_ledger.refinement_slot_events;
  DROP TABLE vynvori_ledger.refinement_slots;
  DROP TABLE vynvori_ledger.ledger_package_events;
  DROP FUNCTION vynvori_ledger.refinement_slot_events_check_complete();
  DROP FUNCTION vynvori_ledger.refinement_slot_events_apply();
  DROP FUNCTION vynvori_ledger.refinement_slot_events_bind();
  DROP FUNCTION vynvori_ledger.refinement_slots_update_guard();
  DROP FUNCTION vynvori_ledger.refinement_slots_insert_guard();
  DROP FUNCTION vynvori_ledger.ledger_package_events_check_complete();
  DROP FUNCTION vynvori_ledger.ledger_package_events_apply();
  DROP FUNCTION vynvori_ledger.ledger_package_events_bind();
  DROP FUNCTION vynvori_ledger.ledger_packages_update_guard();
  DROP FUNCTION vynvori_ledger.refinement_slot_edge_allowed(text, text);
  DROP FUNCTION vynvori_ledger.ledger_package_edge_allowed(text, text);
  DROP FUNCTION vynvori_ledger.ledger_command_is_current(uuid, uuid, text);
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0007_refinement_slots.sql';
END
$rollback$;
