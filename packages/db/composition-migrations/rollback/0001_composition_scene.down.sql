-- ROLLBACK for 0001_composition_scene.sql (ADR-0017). NOT executed by any runner; an operator runs it by hand after a
-- verified pg_dump of schema vynvori_composition. It refuses to run while ANY customer composition data exists, so a
-- rollback can never silently destroy saved work. Drop order respects the RESTRICT foreign keys.
DO $guard$
BEGIN
  IF to_regclass('vynvori_composition.compositions') IS NULL THEN RAISE EXCEPTION 'schema not present'; END IF;
  IF EXISTS (SELECT 1 FROM vynvori_composition.compositions) OR EXISTS (SELECT 1 FROM vynvori_composition.assets)
     OR EXISTS (SELECT 1 FROM vynvori_composition.composition_versions) THEN
    RAISE EXCEPTION 'refusing rollback: customer composition data exists; export it and delete rows deliberately first';
  END IF;
END
$guard$;
DROP SCHEMA vynvori_composition CASCADE;
DELETE FROM vynvori_composition_migrations.applied WHERE file = '0001_composition_scene.sql';
