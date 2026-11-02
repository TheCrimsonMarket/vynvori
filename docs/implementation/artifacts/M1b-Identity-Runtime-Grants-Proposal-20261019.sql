-- OWNER REVIEW PROPOSAL ONLY. Do not execute without separate live authorization and verified backup/inspection.
-- Existing M2 migration/setup owner; no root DATABASE_URL or production branch fallback.
BEGIN;
DO $$
BEGIN
  IF current_database()<>'vynvori_creative_staging' OR current_user<>'vynvori_staging_app' THEN
    RAISE EXCEPTION 'Unexpected database or setup identity';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vynvori_identity_runtime_scoped') THEN
    RAISE EXCEPTION 'Runtime role already exists; inspect instead of altering it';
  END IF;
  IF to_regclass('vynvori_identity.commerce_mappings') IS NULL OR to_regclass('vynvori_identity_migrations.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'Reviewed migration and read-only checksum inspection required first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
    WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type IN ('CREATE','TEMPORARY')) THEN
    RAISE EXCEPTION 'Existing public database privileges require review';
  END IF;
END $$;
CREATE ROLE vynvori_identity_runtime_scoped NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
GRANT CONNECT ON DATABASE vynvori_creative_staging TO vynvori_identity_runtime_scoped;
GRANT USAGE ON SCHEMA vynvori_identity TO vynvori_identity_runtime_scoped;
GRANT SELECT,INSERT,UPDATE ON TABLE
  vynvori_identity.profiles,vynvori_identity.login_transactions,vynvori_identity.sessions,
  vynvori_identity.guest_drafts,vynvori_identity.commerce_mappings TO vynvori_identity_runtime_scoped;
COMMIT;
-- No password, LOGIN activation, owner membership, sequence, default, public schema, migration-history,
-- DELETE/TRUNCATE or Medusa privilege is granted. Credential creation/custody and LOGIN need separate review.
