-- 0005_reservations (ADR-0021, M7 S5). Authorizations, bundle packages, per-operation credit reservations, and the
-- entry<->reservation binding that lets `reserve` and `release` ledger entries exist.
-- Additive: creates objects in vynvori_ledger, adds triggers/constraints to S2's ledger_entries and S3's ledger_quotes, and
-- replaces S2's TEMPORARY constraint ledger_entries_s2_grant_only with the equally temporary ledger_entries_s5_kinds (grant,
-- reserve, release; S6 widens it to settle/hold). No GRANT; the only REVOKE is function-level FROM PUBLIC; no role, no owner
-- change, no rows inserted, nothing in vynvori_identity altered, no Medusa object referenced.
--
-- Privilege model B (ADR-0021 D3, BINDING for S5 and registry hard gate "S5 reservation guards"): reservation state is written
-- ONLY by the SECURITY DEFINER function ledger_entries_apply_to_reservation(), fired by an INSERT into ledger_entries.
-- credit_reservations_update_guard rejects any state change unless BOTH pg_trigger_depth() > 1 AND current_user is the OWNER
-- OF THAT FUNCTION (compared by name with pg_get_userbyid, never a regrole cast). pg_trigger_depth() alone is never enough.
-- The rollout re-owns this function to a dedicated NOLOGIN role (S9, founder-executed, never in a migration); the guard follows
-- the function, not the table. Every function pins search_path = pg_catalog, pg_temp, schema-qualifies every object, uses no
-- dynamic SQL, and verifies what fired it (TG_RELID, TG_OP, TG_WHEN, TG_LEVEL).
--
-- "Written by the current transaction" (ADR-0021 S2 carry-forward: an entry must not reference an earlier-committed command):
-- a row's xmin is widened to a full xid8 against pg_current_xact_id() (nearest epoch) and pg_xact_status() must report
-- 'in progress'. A row that is VISIBLE to us and whose inserting transaction is still in progress can only be ours (MVCC hides
-- other sessions' uncommitted rows); this holds for rows written inside our own savepoints too. Used only on immutable tables
-- (ledger_commands, ledger_authorizations), whose xmin never changes.

-- ---- entry kinds: S2's temporary grant-only constraint gives way to the S5 set ------------------------------------------
ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s2_grant_only;
ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_s5_kinds CHECK (entry_kind IN ('grant', 'reserve', 'release'));

-- ---- authorizations: one per quote lineage, ever ---------------------------------------------------------------------------
CREATE TABLE vynvori_ledger.ledger_authorizations(
  authorization_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES vynvori_ledger.wallets(user_id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  quote_version_id text NOT NULL REFERENCES vynvori_ledger.ledger_quotes(quote_version_id) ON DELETE RESTRICT,
  quote_id text NOT NULL,
  operation_kind text NOT NULL CONSTRAINT ledger_authorizations_operation_kind CHECK (operation_kind IN ('concept_bundle_3x2', 'final_standard', 'final_premium')),
  consent_text_version text NOT NULL CONSTRAINT ledger_authorizations_consent_shape CHECK (length(consent_text_version) BETWEEN 1 AND 256),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_authorizations_command_fk FOREIGN KEY (command_id, user_id) REFERENCES vynvori_ledger.ledger_commands(command_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_authorizations_quote_version_unique UNIQUE (quote_version_id),
  CONSTRAINT ledger_authorizations_quote_id_unique UNIQUE (quote_id),
  CONSTRAINT ledger_authorizations_command_unique UNIQUE (command_id),
  CONSTRAINT ledger_authorizations_id_user UNIQUE (authorization_id, user_id)
);

-- BEFORE INSERT: the authorized quote version must be the caller's own, the latest version of its lineage, of the same kind
-- and consent text, and the command must be an applied reservation_authorize command written in THIS transaction.
CREATE FUNCTION vynvori_ledger.ledger_authorizations_check_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  q record;
  latest integer;
  cmd record;
  ref8 bigint;
  full8 bigint;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_authorizations'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT lq.user_id, lq.quote_id, lq.operation_kind, lq.consent_text_version, lq.version_no INTO q
    FROM vynvori_ledger.ledger_quotes lq WHERE lq.quote_version_id = NEW.quote_version_id;
  IF NOT FOUND OR q.user_id IS DISTINCT FROM NEW.user_id OR q.quote_id IS DISTINCT FROM NEW.quote_id
     OR q.operation_kind IS DISTINCT FROM NEW.operation_kind OR q.consent_text_version IS DISTINCT FROM NEW.consent_text_version THEN
    RAISE EXCEPTION 'an authorization must match its own quote version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT max(lq.version_no) INTO latest FROM vynvori_ledger.ledger_quotes lq WHERE lq.quote_id = NEW.quote_id;
  IF latest IS DISTINCT FROM q.version_no THEN
    RAISE EXCEPTION 'only the latest version of a quote can be authorized' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.command_kind, c.xmin AS x INTO cmd FROM vynvori_ledger.ledger_commands c
    WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied';
  IF NOT FOUND OR cmd.command_kind <> 'reservation_authorize' THEN
    RAISE EXCEPTION 'an authorization must reference an applied reservation_authorize command of the same user' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | cmd.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'an authorization must reference a command written in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_authorizations_check_insert BEFORE INSERT ON vynvori_ledger.ledger_authorizations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_authorizations_check_insert();
CREATE TRIGGER ledger_authorizations_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_authorizations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_authorizations_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_authorizations FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- ---- bundle packages: created 'authorized' with their bundle authorization; no transition exists until S7 -----------------
CREATE TABLE vynvori_ledger.ledger_packages(
  package_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  state text NOT NULL CONSTRAINT ledger_packages_state CHECK (state IN ('quoted', 'authorized', 'partial', 'delivered_3_of_3', 'open_for_refinements', 'closure_pending', 'closed', 'remedy_pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_packages_authorization_fk FOREIGN KEY (authorization_id, user_id) REFERENCES vynvori_ledger.ledger_authorizations(authorization_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_packages_authorization_unique UNIQUE (authorization_id),
  CONSTRAINT ledger_packages_id_user UNIQUE (package_id, user_id)
);

-- BEFORE INSERT: a package is born 'authorized', for a concept_bundle_3x2 authorization written in THIS transaction.
CREATE FUNCTION vynvori_ledger.ledger_packages_check_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  a record;
  ref8 bigint;
  full8 bigint;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_packages'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> 'authorized' THEN
    RAISE EXCEPTION 'a package is created authorized' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT la.operation_kind, la.xmin AS x INTO a FROM vynvori_ledger.ledger_authorizations la
    WHERE la.authorization_id = NEW.authorization_id AND la.user_id = NEW.user_id;
  IF NOT FOUND OR a.operation_kind <> 'concept_bundle_3x2' THEN
    RAISE EXCEPTION 'a package belongs to a concept bundle authorization of the same user' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | a.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a package is created in the same transaction as its authorization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_packages_check_insert BEFORE INSERT ON vynvori_ledger.ledger_packages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_packages_check_insert();
-- S5 has no package transition at all (S7 adds the evidence-gated ones): every UPDATE is rejected.
CREATE TRIGGER ledger_packages_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_packages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_packages_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_packages FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- ---- credit reservations: one per provider operation (D5), frozen units, state written only through ledger entries -------
CREATE TABLE vynvori_ledger.credit_reservations(
  reservation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  quote_version_id text NOT NULL,
  operation_index smallint NOT NULL CONSTRAINT credit_reservations_index_bounds CHECK (operation_index >= 0),
  operation_kind text NOT NULL CONSTRAINT credit_reservations_operation_kind CHECK (operation_kind IN ('concept_bundle_3x2', 'final_standard', 'final_premium')),
  operation_id text NOT NULL CONSTRAINT credit_reservations_operation_id_shape CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  hold_units bigint NOT NULL CONSTRAINT credit_reservations_hold_bounds CHECK (hold_units > 0 AND hold_units <= 9007199254740991),
  charge_units bigint NOT NULL CONSTRAINT credit_reservations_charge_bounds CHECK (charge_units > 0 AND charge_units <= hold_units),
  state text NOT NULL CONSTRAINT credit_reservations_state CHECK (state IN ('authorization_requested', 'reserved', 'settled', 'released', 'reconciliation_hold', 'operator_remedy')),
  package_id uuid NULL,
  original_package_id uuid NULL,
  pre_attempt_package_state text NULL CONSTRAINT credit_reservations_pre_attempt_state CHECK (pre_attempt_package_state IN ('quoted', 'authorized', 'partial', 'delivered_3_of_3', 'open_for_refinements', 'closure_pending', 'closed', 'remedy_pending')),
  workflow_ref text NULL CONSTRAINT credit_reservations_workflow_ref_shape CHECK (length(workflow_ref) BETWEEN 1 AND 256 AND workflow_ref ~ '^[A-Za-z0-9._:/-]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_reservations_authorization_fk FOREIGN KEY (authorization_id, user_id) REFERENCES vynvori_ledger.ledger_authorizations(authorization_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT credit_reservations_allocation_fk FOREIGN KEY (quote_version_id, operation_index) REFERENCES vynvori_ledger.ledger_quote_allocations(quote_version_id, operation_index) ON DELETE RESTRICT,
  CONSTRAINT credit_reservations_package_fk FOREIGN KEY (package_id, user_id) REFERENCES vynvori_ledger.ledger_packages(package_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT credit_reservations_original_package_fk FOREIGN KEY (original_package_id, user_id) REFERENCES vynvori_ledger.ledger_packages(package_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT credit_reservations_allocation_unique UNIQUE (quote_version_id, operation_index),
  CONSTRAINT credit_reservations_operation_unique UNIQUE (operation_id),
  CONSTRAINT credit_reservations_id_user UNIQUE (reservation_id, user_id),
  -- D9 / doc 06 C-02: a final records the original package and its state before the attempt; a bundle operation belongs to its own package.
  CONSTRAINT credit_reservations_kind_shape CHECK (
    (operation_kind = 'concept_bundle_3x2' AND package_id IS NOT NULL AND original_package_id IS NULL AND pre_attempt_package_state IS NULL)
 OR (operation_kind IN ('final_standard', 'final_premium') AND package_id IS NULL AND original_package_id IS NOT NULL AND pre_attempt_package_state IS NOT NULL))
);

-- BEFORE INSERT: a reservation is born 'authorization_requested' with no workflow reference, for an authorization written in THIS
-- transaction, with exactly the frozen allocation units of its own quote version, and (bundle) its own package or (final) the
-- caller's original package, a different one, in exactly the recorded state.
CREATE FUNCTION vynvori_ledger.credit_reservations_check_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  a record;
  al record;
  p record;
  ref8 bigint;
  full8 bigint;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.credit_reservations'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> 'authorization_requested' OR NEW.workflow_ref IS NOT NULL THEN
    RAISE EXCEPTION 'a reservation is created authorization_requested and not yet dispatched' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT la.quote_version_id, la.operation_kind, la.xmin AS x INTO a FROM vynvori_ledger.ledger_authorizations la
    WHERE la.authorization_id = NEW.authorization_id AND la.user_id = NEW.user_id;
  IF NOT FOUND OR a.quote_version_id IS DISTINCT FROM NEW.quote_version_id OR a.operation_kind IS DISTINCT FROM NEW.operation_kind THEN
    RAISE EXCEPTION 'a reservation must match its authorization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | a.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a reservation is created in the same transaction as its authorization' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT qa.hold_units, qa.charge_units INTO al FROM vynvori_ledger.ledger_quote_allocations qa
    WHERE qa.quote_version_id = NEW.quote_version_id AND qa.operation_index = NEW.operation_index;
  IF NOT FOUND OR al.hold_units IS DISTINCT FROM NEW.hold_units OR al.charge_units IS DISTINCT FROM NEW.charge_units THEN
    RAISE EXCEPTION 'reservation units must equal the frozen allocation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.operation_kind = 'concept_bundle_3x2' THEN
    IF NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_packages lp WHERE lp.package_id = NEW.package_id AND lp.user_id = NEW.user_id AND lp.authorization_id = NEW.authorization_id) THEN
      RAISE EXCEPTION 'a bundle reservation belongs to the package of its own authorization' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    SELECT lp.state, lp.authorization_id INTO p FROM vynvori_ledger.ledger_packages lp WHERE lp.package_id = NEW.original_package_id AND lp.user_id = NEW.user_id;
    IF NOT FOUND OR p.state IS DISTINCT FROM NEW.pre_attempt_package_state OR p.authorization_id = NEW.authorization_id THEN
      RAISE EXCEPTION 'a final reservation records the caller''s original package in its current state' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER credit_reservations_check_insert BEFORE INSERT ON vynvori_ledger.credit_reservations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.credit_reservations_check_insert();

-- BEFORE UPDATE: identity and units are immutable. A STATE change only through the SECURITY DEFINER apply function (depth > 1 AND
-- current_user = owner of ledger_entries_apply_to_reservation()) and only along the S5 edges. The only direct update is recording
-- the workflow reference once (NULL -> value) on a reserved reservation, with nothing else changing.
CREATE FUNCTION vynvori_ledger.credit_reservations_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.credit_reservations'::pg_catalog.regclass OR TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.reservation_id, NEW.user_id, NEW.authorization_id, NEW.quote_version_id, NEW.operation_index, NEW.operation_kind, NEW.operation_id,
      NEW.hold_units, NEW.charge_units, NEW.package_id, NEW.original_package_id, NEW.pre_attempt_package_state, NEW.created_at)
     IS DISTINCT FROM
     (OLD.reservation_id, OLD.user_id, OLD.authorization_id, OLD.quote_version_id, OLD.operation_index, OLD.operation_kind, OLD.operation_id,
      OLD.hold_units, OLD.charge_units, OLD.package_id, OLD.original_package_id, OLD.pre_attempt_package_state, OLD.created_at) THEN
    RAISE EXCEPTION 'reservation identity and units are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF pg_trigger_depth() <= 1 OR current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('vynvori_ledger.ledger_entries_apply_to_reservation()'))) THEN
      RAISE EXCEPTION 'reservation state changes only through ledger entries' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.workflow_ref IS DISTINCT FROM OLD.workflow_ref
       OR NOT ((OLD.state = 'authorization_requested' AND NEW.state = 'reserved') OR (OLD.state = 'reserved' AND NEW.state = 'released')) THEN
      RAISE EXCEPTION 'illegal reservation transition' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.workflow_ref IS NOT NULL OR NEW.workflow_ref IS NULL OR OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'the workflow reference is recorded once, on a reserved reservation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER credit_reservations_update_guard BEFORE UPDATE ON vynvori_ledger.credit_reservations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.credit_reservations_update_guard();
CREATE TRIGGER credit_reservations_no_delete BEFORE DELETE ON vynvori_ledger.credit_reservations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER credit_reservations_no_truncate BEFORE TRUNCATE ON vynvori_ledger.credit_reservations FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- DEFERRED: no reservation may be left in authorization_requested at COMMIT (its reserve entry must land in the same transaction).
CREATE FUNCTION vynvori_ledger.credit_reservations_check_not_pending() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.credit_reservations'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations r WHERE r.reservation_id = NEW.reservation_id AND r.state = 'authorization_requested') THEN
    RAISE EXCEPTION 'a reservation was left in authorization_requested' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER credit_reservations_check_not_pending AFTER INSERT ON vynvori_ledger.credit_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.credit_reservations_check_not_pending();

-- DEFERRED: an authorization commits only together with exactly one 'reserved' reservation per frozen allocation (D5 atomic
-- bundle), and with a package if and only if it is a bundle.
CREATE FUNCTION vynvori_ledger.ledger_authorizations_check_complete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  allocations integer;
  reserved integer;
  total integer;
  packages integer;
  expected_packages integer;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_authorizations'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO allocations FROM vynvori_ledger.ledger_quote_allocations qa WHERE qa.quote_version_id = NEW.quote_version_id;
  SELECT count(*), count(*) FILTER (WHERE r.state = 'reserved') INTO total, reserved FROM vynvori_ledger.credit_reservations r WHERE r.authorization_id = NEW.authorization_id;
  SELECT count(*) INTO packages FROM vynvori_ledger.ledger_packages lp WHERE lp.authorization_id = NEW.authorization_id;
  IF allocations = 0 OR total <> allocations OR reserved <> allocations THEN
    RAISE EXCEPTION 'an authorization must reserve every allocation of its quote version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  expected_packages := CASE WHEN NEW.operation_kind = 'concept_bundle_3x2' THEN 1 ELSE 0 END;
  IF packages <> expected_packages THEN
    RAISE EXCEPTION 'a bundle authorization has exactly one package; a final has none' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER ledger_authorizations_check_complete AFTER INSERT ON vynvori_ledger.ledger_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_authorizations_check_complete();

-- ---- entry <-> reservation binding --------------------------------------------------------------------------------------------
ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_reservation_fk FOREIGN KEY (reservation_id, user_id) REFERENCES vynvori_ledger.credit_reservations(reservation_id, user_id) ON DELETE RESTRICT;
-- At most one terminal entry per reservation, whichever kind (release now; settle/hold from S6). (reservation_id, entry_kind)
-- is already unique through ledger_entries_cause_unique, since cause_ref = reservation_id || ':' || entry_kind by CHECK.
CREATE UNIQUE INDEX ledger_entries_one_terminal_per_reservation ON vynvori_ledger.ledger_entries(reservation_id) WHERE entry_kind IN ('release', 'settle', 'hold');

-- BEFORE INSERT on ledger_entries (reservation kinds only): the command is an applied command of the same user, of the matching
-- kind, written in THIS transaction; the reservation is the same user's, locked, in the legal source state, with exactly its
-- frozen hold units; reserve carries its authorization as evidence (of this very command), release carries verified-zero-charge
-- evidence and needs a dispatched reservation. The state write itself is done by the definer function below.
CREATE FUNCTION vynvori_ledger.ledger_entries_bind_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  cmd record;
  r record;
  expected_kind text;
  ref8 bigint;
  full8 bigint;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_entries'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_kind = 'grant' THEN RETURN NEW; END IF;
  IF NEW.entry_kind NOT IN ('reserve', 'release') THEN
    RAISE EXCEPTION 'entry kind % is not available yet', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.command_kind, c.xmin AS x INTO cmd FROM vynvori_ledger.ledger_commands c
    WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied';
  expected_kind := CASE NEW.entry_kind WHEN 'reserve' THEN 'reservation_authorize' ELSE 'reservation_release' END;
  IF NOT FOUND OR cmd.command_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'a % entry must reference an applied command of the matching kind', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | cmd.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a reservation entry must reference a command written in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT cr.state, cr.hold_units, cr.authorization_id, cr.workflow_ref INTO r FROM vynvori_ledger.credit_reservations cr
    WHERE cr.reservation_id = NEW.reservation_id AND cr.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found for this user' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_kind = 'reserve' THEN
    IF r.state <> 'authorization_requested' OR NEW.delta_reserved IS DISTINCT FROM r.hold_units
       OR NEW.evidence_kind <> 'authorization' OR NEW.evidence_ref IS DISTINCT FROM r.authorization_id::text
       OR NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_authorizations la WHERE la.authorization_id = r.authorization_id AND la.command_id = NEW.command_id) THEN
      RAISE EXCEPTION 'reserve entry does not match its reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF r.state <> 'reserved' OR r.workflow_ref IS NULL OR NEW.delta_available IS DISTINCT FROM r.hold_units
       OR NEW.evidence_kind <> 'verified_zero_charge_failure' OR length(NEW.evidence_ref) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'release entry does not match its reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_entries_bind_reservation BEFORE INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_entries_bind_reservation();

-- The ONLY writer of reservation state. SECURITY DEFINER: its owner must be a dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS,
-- NOCREATEROLE role before any rollout (S9). It touches credit_reservations only, and re-checks user, source state and units in
-- its own WHERE clause, so it can never move a reservation along an edge the binding trigger did not approve.
CREATE FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_entries'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_kind = 'grant' THEN RETURN NULL; END IF;
  IF NEW.entry_kind = 'reserve' THEN
    UPDATE vynvori_ledger.credit_reservations r SET state = 'reserved'
      WHERE r.reservation_id = NEW.reservation_id AND r.user_id = NEW.user_id AND r.state = 'authorization_requested' AND r.hold_units = NEW.delta_reserved;
  ELSIF NEW.entry_kind = 'release' THEN
    UPDATE vynvori_ledger.credit_reservations r SET state = 'released'
      WHERE r.reservation_id = NEW.reservation_id AND r.user_id = NEW.user_id AND r.state = 'reserved' AND r.workflow_ref IS NOT NULL AND r.hold_units = NEW.delta_available;
  ELSE
    RAISE EXCEPTION 'entry kind % is not available yet', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation transition did not apply' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER ledger_entries_apply_to_reservation AFTER INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation();

-- ---- quotes: an authorized lineage can never gain a new version (D7: renewQuote refuses an authorized lineage) --------------
CREATE FUNCTION vynvori_ledger.ledger_quotes_refuse_authorized_lineage() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_quotes'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.ledger_authorizations a WHERE a.quote_id = NEW.quote_id) THEN
    RAISE EXCEPTION 'an authorized quote lineage cannot be renewed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_quotes_refuse_authorized_lineage BEFORE INSERT ON vynvori_ledger.ledger_quotes FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_quotes_refuse_authorized_lineage();

REVOKE ALL ON FUNCTION vynvori_ledger.ledger_authorizations_check_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_packages_check_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.credit_reservations_check_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.credit_reservations_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.credit_reservations_check_not_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_authorizations_check_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_bind_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_quotes_refuse_authorized_lineage() FROM PUBLIC;
