-- 0002_wallet_ledger (ADR-0021, M7 S2). Wallet, immutable command log, append-only ledger, grant-source registry.
-- Additive: creates objects in vynvori_ledger only. No GRANT/REVOKE, nothing in vynvori_identity is altered, no rows are inserted
-- (in particular NO grant source is registered: after this migration no credit can be minted by anyone).
-- Privilege model B (ADR-0021, confirmed by the S2 security review). Exactly ONE function is SECURITY DEFINER:
-- ledger_entries_apply_to_wallet(). Its effective privilege is the OWNER's, so the owner must be a dedicated NOLOGIN,
-- NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE role before any rollout (ADR-0021 S2 addendum, S9 grants proposal). Every function
-- pins search_path = pg_catalog, pg_temp (pg_temp LAST) and schema-qualifies every object; none uses dynamic SQL. Every
-- function gets REVOKE ALL ... FROM PUBLIC (hardening only; the migration grants nothing and names no role).
--
-- Wallet buckets change ONLY through ledger entries:
--   * ledger_entries rejects UPDATE/DELETE/TRUNCATE;
--   * wallets rejects a non-zero INSERT, DELETE and TRUNCATE, and rejects UPDATE unless BOTH pg_trigger_depth() > 1 AND the
--     current user is the table owner. A direct UPDATE fires wallets_update_guard at depth 1. The UPDATE issued by the
--     SECURITY DEFINER apply function runs as the owner at depth 2. A trigger created by any other role (even one holding
--     pg_write_all_data) runs as that role and is rejected; the depth check alone is NOT sufficient (a pg_temp trigger
--     reaches depth 2).
--
-- TEMPORARY CONSTRAINT: ledger_entries_s2_grant_only restricts entries to kind 'grant' until S5 adds the entry<->reservation
-- binding trigger. S5's migration drops it; S5's rollback re-adds it. Do not remove it earlier.

CREATE FUNCTION vynvori_ledger.reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'vynvori_ledger.% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;

CREATE TABLE vynvori_ledger.wallets(
  user_id uuid PRIMARY KEY REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT,
  available_units bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_available_bounds CHECK (available_units >= 0 AND available_units <= 9007199254740991),
  reserved_units bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_reserved_bounds CHECK (reserved_units >= 0 AND reserved_units <= 9007199254740991),
  held_for_review_units bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_held_bounds CHECK (held_for_review_units >= 0 AND held_for_review_units <= 9007199254740991),
  consumed_units bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_consumed_bounds CHECK (consumed_units >= 0 AND consumed_units <= 9007199254740991),
  revision bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_revision_bounds CHECK (revision >= 0 AND revision <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION vynvori_ledger.wallets_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.available_units <> 0 OR NEW.reserved_units <> 0 OR NEW.held_for_review_units <> 0 OR NEW.consumed_units <> 0 OR NEW.revision <> 0 THEN
    RAISE EXCEPTION 'a wallet can only be created empty; balances change through ledger entries' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER wallets_insert_guard BEFORE INSERT ON vynvori_ledger.wallets FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.wallets_insert_guard();

CREATE FUNCTION vynvori_ledger.wallets_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF pg_trigger_depth() <= 1 OR current_user::pg_catalog.regrole::pg_catalog.oid <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION 'wallet balances change only through ledger entries' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER wallets_update_guard BEFORE UPDATE ON vynvori_ledger.wallets FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.wallets_update_guard();
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON vynvori_ledger.wallets FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON vynvori_ledger.wallets FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.ledger_commands(
  command_id uuid PRIMARY KEY,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 char(64) NOT NULL,
  user_id uuid NOT NULL REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT,
  command_kind text NOT NULL,
  outcome text NOT NULL CONSTRAINT ledger_commands_outcome CHECK (outcome IN ('applied','rejected')),
  rejection_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_commands_scope_key UNIQUE (scope, idempotency_key),
  CONSTRAINT ledger_commands_id_user UNIQUE (command_id, user_id),
  CONSTRAINT ledger_commands_scope_shape CHECK (scope = user_id::text || ':' || command_kind),
  CONSTRAINT ledger_commands_hash_shape CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ledger_commands_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  CONSTRAINT ledger_commands_kind_shape CHECK (command_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ledger_commands_rejection CHECK ((outcome = 'rejected') = (rejection_code IS NOT NULL))
);
CREATE TRIGGER ledger_commands_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_commands FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_commands_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_commands FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.ledger_grant_sources(
  grant_source_id uuid PRIMARY KEY,
  kind text NOT NULL CONSTRAINT ledger_grant_sources_kind CHECK (kind IN ('synthetic_test','medusa_payment_capture','operator_adjustment')),
  label text NOT NULL CONSTRAINT ledger_grant_sources_label CHECK (length(label) BETWEEN 1 AND 128),
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ledger_grant_sources_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_grant_sources FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_grant_sources_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_grant_sources FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.ledger_entries(
  entry_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES vynvori_ledger.wallets(user_id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  entry_kind text NOT NULL CONSTRAINT ledger_entries_kind CHECK (entry_kind IN ('grant','reserve','release','settle','hold')),
  delta_available bigint NOT NULL CONSTRAINT ledger_entries_delta_available_bounds CHECK (delta_available BETWEEN -9007199254740991 AND 9007199254740991),
  delta_reserved bigint NOT NULL CONSTRAINT ledger_entries_delta_reserved_bounds CHECK (delta_reserved BETWEEN -9007199254740991 AND 9007199254740991),
  delta_held bigint NOT NULL CONSTRAINT ledger_entries_delta_held_bounds CHECK (delta_held BETWEEN -9007199254740991 AND 9007199254740991),
  delta_consumed bigint NOT NULL CONSTRAINT ledger_entries_delta_consumed_bounds CHECK (delta_consumed BETWEEN -9007199254740991 AND 9007199254740991),
  delta_external bigint NOT NULL CONSTRAINT ledger_entries_delta_external_bounds CHECK (delta_external BETWEEN -9007199254740991 AND 9007199254740991),
  grant_source_id uuid NULL REFERENCES vynvori_ledger.ledger_grant_sources(grant_source_id) ON DELETE RESTRICT,
  source_ref text NULL,
  reservation_id uuid NULL, -- no FK yet: S5 adds it together with credit_reservations
  evidence_kind text NULL,
  evidence_ref text NULL,
  cause_kind text NOT NULL,
  cause_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_command_fk FOREIGN KEY (command_id, user_id) REFERENCES vynvori_ledger.ledger_commands(command_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_entries_cause_unique UNIQUE (cause_kind, cause_ref),
  CONSTRAINT ledger_entries_balanced CHECK (delta_available + delta_reserved + delta_held + delta_consumed + delta_external = 0),
  CONSTRAINT ledger_entries_sign_shape CHECK (
    (entry_kind = 'grant'   AND delta_available > 0 AND delta_reserved = 0 AND delta_held = 0 AND delta_consumed = 0 AND delta_external = -delta_available)
 OR (entry_kind = 'reserve' AND delta_available < 0 AND delta_reserved = -delta_available AND delta_held = 0 AND delta_consumed = 0 AND delta_external = 0)
 OR (entry_kind = 'release' AND delta_available > 0 AND delta_reserved = -delta_available AND delta_held = 0 AND delta_consumed = 0 AND delta_external = 0)
 OR (entry_kind = 'settle'  AND delta_reserved < 0 AND delta_consumed > 0 AND delta_available >= 0 AND delta_held = 0 AND delta_external = 0 AND delta_available + delta_consumed = -delta_reserved)
 OR (entry_kind = 'hold'    AND delta_reserved < 0 AND delta_held = -delta_reserved AND delta_available = 0 AND delta_consumed = 0 AND delta_external = 0)),
  CONSTRAINT ledger_entries_source_shape CHECK (
    (entry_kind = 'grant' AND grant_source_id IS NOT NULL AND source_ref IS NOT NULL AND source_ref ~ '^[A-Za-z0-9._:-]{1,128}$'
       AND reservation_id IS NULL AND evidence_kind IS NULL AND evidence_ref IS NULL
       AND cause_kind = 'grant' AND cause_ref = grant_source_id::text || ':' || source_ref)
 OR (entry_kind <> 'grant' AND grant_source_id IS NULL AND source_ref IS NULL AND reservation_id IS NOT NULL AND evidence_kind IS NOT NULL AND evidence_ref IS NOT NULL
       AND cause_kind = 'reservation' AND cause_ref = reservation_id::text || ':' || entry_kind)),
  CONSTRAINT ledger_entries_s2_grant_only CHECK (entry_kind = 'grant')
);

CREATE FUNCTION vynvori_ledger.ledger_entries_check_command() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_commands c WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied') THEN
    RAISE EXCEPTION 'a ledger entry must reference an applied command of the same user' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_entries_check_command BEFORE INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_entries_check_command();

-- Applies the five-bucket deltas to the wallet. delta_external is the counter-side of a grant and has no wallet column.
-- The wallet CHECKs (>= 0, <= safe integer) are the backstop against a negative or overflowing result.
CREATE FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  UPDATE vynvori_ledger.wallets w SET
    available_units = w.available_units + NEW.delta_available,
    reserved_units = w.reserved_units + NEW.delta_reserved,
    held_for_review_units = w.held_for_review_units + NEW.delta_held,
    consumed_units = w.consumed_units + NEW.delta_consumed,
    revision = w.revision + 1
  WHERE w.user_id = NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet missing for ledger entry' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER ledger_entries_apply_to_wallet AFTER INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet();

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

REVOKE ALL ON FUNCTION vynvori_ledger.reject_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.wallets_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.wallets_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_check_command() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() FROM PUBLIC;
