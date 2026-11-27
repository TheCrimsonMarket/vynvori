-- ROLLBACK for 0004_promo_claims.sql (ADR-0021). NOT executed by any runner; an operator runs it by hand on a disposable
-- database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while ANY row exists in promo_claims or promo_claim_events, and while a later migration is journaled (roll those
-- back first, in reverse order). Both tables are append-only (triggers reject DELETE/TRUNCATE, and events also UPDATE), so
-- removing real promo data means RESTORE FROM BACKUP, not running this script. A promo claim is the only record that an identity
-- has used its one promo preview: deleting it would re-offer the promo, so the refusal is deliberate.
-- No GRANT; the only REVOKE is function-level FROM PUBLIC; no SECURITY DEFINER. One DO block: a failed guard can never be
-- followed by a surviving DROP even under plain `psql -f` without ON_ERROR_STOP. 0002's reject_mutation() is NOT dropped here:
-- it is owned by 0002 and is still used by its own tables.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0004_promo_claims.sql') THEN
    RAISE EXCEPTION '0004_promo_claims is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0004_promo_claims.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.promo_claims') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.promo_claim_events') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0004 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.promo_claims, vynvori_ledger.promo_claim_events IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.promo_claim_events) OR EXISTS (SELECT 1 FROM vynvori_ledger.promo_claims) THEN
    RAISE EXCEPTION 'refusing rollback: rows exist in the promo tables; promo data is restored from backup, never deleted';
  END IF;
  DROP TABLE vynvori_ledger.promo_claim_events;
  DROP TABLE vynvori_ledger.promo_claims;
  DROP FUNCTION vynvori_ledger.promo_claim_events_apply();
  DROP FUNCTION vynvori_ledger.promo_claim_events_check();
  DROP FUNCTION vynvori_ledger.promo_claims_update_guard();
  DROP FUNCTION vynvori_ledger.promo_claims_insert_guard();
  DROP FUNCTION vynvori_ledger.promo_claim_edge_allowed(text, text);
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0004_promo_claims.sql';
END
$rollback$;
