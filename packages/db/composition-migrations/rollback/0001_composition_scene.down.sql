-- ROLLBACK for 0001_composition_scene.sql (ADR-0018; repaired by ADR-0022 C3a / plan finding F8). NOT executed by
-- any runner; an operator runs it by hand after a verified pg_dump of schema vynvori_composition. It refuses to run
-- while any LATER migration's journal row exists (0002 must be rolled back first, by its own down script, or a
-- CASCADE drop of this schema would silently destroy its tables too), and, as before, while any customer
-- composition data exists, so a rollback can never silently destroy saved work. After dropping the data schema and
-- deleting this journal row, it also drops the now-empty journal schema itself: the runner's
-- HISTORY_OR_SCHEMA_DRIFT check compares "does a journal row exist" against "does the data schema exist", and a
-- journal schema left behind with zero rows, next to no data schema, previously read as drift and blocked
-- re-apply. Drop order respects the RESTRICT foreign keys.
DO $guard$
BEGIN
  IF to_regclass('vynvori_composition.compositions') IS NULL THEN RAISE EXCEPTION 'schema not present'; END IF;
  IF EXISTS (SELECT file FROM vynvori_composition_migrations.applied WHERE file <> '0001_composition_scene.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later migration is still applied; roll it back first';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_composition.compositions) OR EXISTS (SELECT 1 FROM vynvori_composition.assets)
     OR EXISTS (SELECT 1 FROM vynvori_composition.composition_versions) THEN
    RAISE EXCEPTION 'refusing rollback: customer composition data exists; export it and delete rows deliberately first';
  END IF;
END
$guard$;
DROP SCHEMA vynvori_composition CASCADE;
DELETE FROM vynvori_composition_migrations.applied WHERE file = '0001_composition_scene.sql';
DROP SCHEMA vynvori_composition_migrations CASCADE;
