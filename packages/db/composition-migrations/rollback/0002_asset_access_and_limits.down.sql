-- ROLLBACK for 0002_asset_access_and_limits.sql (ADR-0022 C3a). NOT executed by any runner; an operator runs it by
-- hand after a verified pg_dump of the three append-only/mostly-immutable tables. It refuses to run while ANY row
-- exists in asset_scan_events, asset_scan_attempts or asset_download_grants, so a rollback can never silently
-- destroy scan history, an in-flight scan reservation or an issued download grant. Because those tables are
-- append-only by trigger, clearing them (if ever truly required) needs a superuser to disable the triggers first;
-- this script does not do that. rate_limit_buckets rows may be dropped: that table holds no customer-facing fact,
-- only a rolling admission counter. Drops only 0002 objects; 0001 and its data are untouched and stay re-appliable.
DO $guard$
BEGIN
  IF to_regclass('vynvori_composition.asset_scan_events') IS NULL THEN RAISE EXCEPTION 'schema objects not present'; END IF;
  IF EXISTS (SELECT 1 FROM vynvori_composition.asset_scan_events) OR EXISTS (SELECT 1 FROM vynvori_composition.asset_scan_attempts)
     OR EXISTS (SELECT 1 FROM vynvori_composition.asset_download_grants) THEN
    RAISE EXCEPTION 'refusing rollback: scan events, scan attempts or download grants exist; export them and delete rows deliberately first';
  END IF;
END
$guard$;

DROP TABLE vynvori_composition.asset_scan_events;
DROP TABLE vynvori_composition.asset_scan_attempts;
DROP TABLE vynvori_composition.asset_download_grants;
DROP TABLE vynvori_composition.rate_limit_buckets;
DROP INDEX vynvori_composition.compositions_live_guest_drafts;

DROP FUNCTION vynvori_composition.check_scan_event();
DROP FUNCTION vynvori_composition.check_scan_attempt_update();
DROP FUNCTION vynvori_composition.check_download_grant_update();
DROP FUNCTION vynvori_composition.m3_lock_asset(uuid, uuid);
DROP FUNCTION vynvori_composition.m3_lock_composition(uuid);
DROP FUNCTION vynvori_composition.m3_lock_key_from_hash(integer);

DELETE FROM vynvori_composition_migrations.applied WHERE file = '0002_asset_access_and_limits.sql';
