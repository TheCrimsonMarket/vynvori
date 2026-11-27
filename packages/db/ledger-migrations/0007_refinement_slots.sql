-- 0007_refinement_slots (ADR-0021, M7 S7). Bundle-package transitions, the two included refinement slots per package, and closure.
-- Additive: creates objects in vynvori_ledger, and replaces ONE S5 trigger (ledger_packages_immutable, which rejected every UPDATE
-- because "no package transition exists until S7") with a delete guard and an owner-checked update guard. No GRANT; the only REVOKE
-- is function-level FROM PUBLIC; no role, no owner change, no rows inserted, nothing in vynvori_identity altered, no Medusa object
-- referenced, no ledger entry written or read for a refinement (refinements never touch a wallet bucket). It does not replace or
-- alter any 0005/0006 function, constraint or table other than that one package trigger.
--
-- Privilege model B (ADR-0021 D3, BINDING; registry hard gate "S5 reservation guards" applies to every guarded state): package and
-- slot state change ONLY through insert-only event tables whose AFTER INSERT trigger is a SECURITY DEFINER function:
--   ledger_package_events -> ledger_package_events_apply() is the only writer of ledger_packages.state and the only inserter of
--                            refinement_slots (it creates the two slots when a package first becomes open_for_refinements);
--   refinement_slot_events -> refinement_slot_events_apply() is the only writer of refinement_slots.state and its fields.
-- Each guard rejects the write unless BOTH pg_trigger_depth() > 1 AND current_user is the OWNER OF THAT FUNCTION (compared by name
-- with pg_get_userbyid, never a regrole cast). pg_trigger_depth() alone is never enough. The rollout re-owns the two functions to a
-- dedicated NOLOGIN role (S9, founder-executed, never in a migration); each guard follows its function, not the table. Every
-- function pins search_path = pg_catalog, pg_temp, schema-qualifies every object, uses no dynamic SQL and verifies what fired it
-- (TG_RELID, TG_OP, TG_WHEN, TG_LEVEL).
--
-- Package edges (doc 22 Plane C / contracts PLANE_C_BUNDLE_GRAPH + canTransitionPlaneCBundle, which this file does not edit):
--   authorized -> partial | delivered_3_of_3, partial -> delivered_3_of_3, delivered_3_of_3 -> open_for_refinements,
--   open_for_refinements -> closure_pending, closure_pending -> closed, and the guarded C-02 reopen
--   closure_pending -> open_for_refinements (only for a RELEASED first final of this package that began on an open package, with its
--   committed verified_zero_charge_failure release entry, and no final of the package settled or unresolved).
--   remedy_pending edges are deferred (remedy execution is a later milestone) and are NOT allowed here.
-- Internal names only (open_for_refinements); the customer projection name (refinements_open) is mapped at the projection boundary.
-- No clock-based expiry exists anywhere in this file. approved_expiry is NOT an allowed closure cause (no approved terms exist).

-- ---- pure edge functions ---------------------------------------------------------------------------------------------------

-- The S7 package edge set. closure_pending -> open_for_refinements is listed because it exists, but ONLY the event binding trigger
-- below can let it through (it demands the C-02 context). A test compares this function with the contracts guard for all 64 pairs.
-- Both edge functions are PURE (no table access) and deliberately NOT revoked from PUBLIC (as 0004's promo edge function): CHECK
-- constraints call them as the invoking role, which must therefore keep EXECUTE. They expose nothing.
CREATE FUNCTION vynvori_ledger.ledger_package_edge_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE((p_from, p_to) IN (
    ('authorized', 'partial'), ('authorized', 'delivered_3_of_3'), ('partial', 'delivered_3_of_3'), ('delivered_3_of_3', 'open_for_refinements'),
    ('open_for_refinements', 'closure_pending'), ('closure_pending', 'closed'), ('closure_pending', 'open_for_refinements')), false)
$fn$;

-- Slot edges (doc 22: skipped reversible while open; pending/unknown locked; used consumes one slot; forfeit only through closure).
CREATE FUNCTION vynvori_ledger.refinement_slot_edge_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT COALESCE((p_from, p_to) IN (
    ('available', 'skipped'), ('skipped', 'available'), ('available', 'pending'), ('pending', 'unknown'), ('pending', 'used'), ('unknown', 'used'),
    ('available', 'forfeited'), ('skipped', 'forfeited')), false)
$fn$;

-- ---- package events: the only way a package state changes ------------------------------------------------------------------
CREATE TABLE vynvori_ledger.ledger_package_events(
  package_event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  package_id uuid NOT NULL,
  command_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  artifact_count smallint NULL CONSTRAINT ledger_package_events_artifact_count CHECK (artifact_count BETWEEN 0 AND 3),
  evidence_ref text NULL CONSTRAINT ledger_package_events_evidence_ref CHECK (length(evidence_ref) BETWEEN 1 AND 512 AND evidence_ref ~ '^[ -~]+$'),
  begin_reason text NULL CONSTRAINT ledger_package_events_begin_reason CHECK (begin_reason IN ('final_authorized', 'explicit_close_request')),
  final_reservation_id uuid NULL,
  closure_cause text NULL CONSTRAINT ledger_package_events_closure_cause CHECK (closure_cause IN ('final_delivered', 'explicit_close')),
  closure_notice_version text NULL CONSTRAINT ledger_package_events_notice_shape CHECK (length(closure_notice_version) BETWEEN 1 AND 256 AND closure_notice_version ~ '^[ -~]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_package_events_package_fk FOREIGN KEY (package_id, user_id) REFERENCES vynvori_ledger.ledger_packages(package_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_package_events_command_fk FOREIGN KEY (command_id, user_id) REFERENCES vynvori_ledger.ledger_commands(command_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_package_events_reservation_fk FOREIGN KEY (final_reservation_id, user_id) REFERENCES vynvori_ledger.credit_reservations(reservation_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_package_events_command_unique UNIQUE (command_id),
  CONSTRAINT ledger_package_events_edge CHECK (vynvori_ledger.ledger_package_edge_allowed(from_state, to_state)),
  -- Typed evidence per edge. 0/3, 1/3 and 2/3 durable artifacts can only ever be `partial`; only a count of exactly 3 is delivered_3_of_3.
  CONSTRAINT ledger_package_events_shape CHECK (
    (to_state = 'partial' AND artifact_count BETWEEN 0 AND 2 AND evidence_ref IS NOT NULL AND begin_reason IS NULL AND final_reservation_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'delivered_3_of_3' AND artifact_count = 3 AND evidence_ref IS NOT NULL AND begin_reason IS NULL AND final_reservation_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (from_state = 'delivered_3_of_3' AND to_state = 'open_for_refinements' AND artifact_count IS NULL AND evidence_ref IS NULL AND begin_reason IS NULL AND final_reservation_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'closure_pending' AND artifact_count IS NULL AND evidence_ref IS NULL AND begin_reason IS NOT NULL AND ((begin_reason = 'final_authorized') = (final_reservation_id IS NOT NULL)) AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'closed' AND artifact_count IS NULL AND evidence_ref IS NULL AND begin_reason IS NULL AND closure_cause IS NOT NULL AND closure_notice_version IS NOT NULL AND ((closure_cause = 'final_delivered') = (final_reservation_id IS NOT NULL)))
 OR (from_state = 'closure_pending' AND to_state = 'open_for_refinements' AND artifact_count IS NULL AND evidence_ref IS NULL AND begin_reason IS NULL AND final_reservation_id IS NOT NULL AND closure_cause IS NULL AND closure_notice_version IS NULL))
);
CREATE TRIGGER ledger_package_events_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_package_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_package_events_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_package_events FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- ---- refinement slots: two per bundle package, created only by the package-event definer ------------------------------------
CREATE TABLE vynvori_ledger.refinement_slots(
  slot_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  package_id uuid NOT NULL,
  ordinal smallint NOT NULL CONSTRAINT refinement_slots_ordinal CHECK (ordinal IN (1, 2)),
  state text NOT NULL CONSTRAINT refinement_slots_state CHECK (state IN ('available', 'skipped', 'pending', 'unknown', 'used', 'forfeited')),
  source_version_id text NULL CONSTRAINT refinement_slots_source_shape CHECK (source_version_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  operation_id text NULL CONSTRAINT refinement_slots_operation_shape CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  delivered_version_id text NULL CONSTRAINT refinement_slots_delivered_shape CHECK (delivered_version_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  closure_cause text NULL CONSTRAINT refinement_slots_closure_cause CHECK (closure_cause IN ('final_delivered', 'explicit_close')),
  closure_notice_version text NULL CONSTRAINT refinement_slots_notice_shape CHECK (length(closure_notice_version) BETWEEN 1 AND 256 AND closure_notice_version ~ '^[ -~]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refinement_slots_package_fk FOREIGN KEY (package_id, user_id) REFERENCES vynvori_ledger.ledger_packages(package_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT refinement_slots_package_ordinal UNIQUE (package_id, ordinal),
  CONSTRAINT refinement_slots_id_user UNIQUE (slot_id, user_id),
  CONSTRAINT refinement_slots_id_package UNIQUE (slot_id, package_id),
  -- Field shape per state, mirroring RefinementSlotV1 (contracts operations.ts).
  CONSTRAINT refinement_slots_shape CHECK (
    (state IN ('available', 'skipped') AND operation_id IS NULL AND delivered_version_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (state IN ('pending', 'unknown') AND source_version_id IS NOT NULL AND operation_id IS NOT NULL AND delivered_version_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (state = 'used' AND source_version_id IS NOT NULL AND operation_id IS NOT NULL AND delivered_version_id IS NOT NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (state = 'forfeited' AND operation_id IS NULL AND delivered_version_id IS NULL AND closure_cause IS NOT NULL AND closure_notice_version IS NOT NULL))
);
-- One provider/Studio operation serves at most one slot; one delivered version consumes at most one slot of a package.
CREATE UNIQUE INDEX refinement_slots_operation_unique ON vynvori_ledger.refinement_slots(operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX refinement_slots_delivered_unique ON vynvori_ledger.refinement_slots(package_id, delivered_version_id) WHERE delivered_version_id IS NOT NULL;
CREATE TRIGGER refinement_slots_no_delete BEFORE DELETE ON vynvori_ledger.refinement_slots FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER refinement_slots_no_truncate BEFORE TRUNCATE ON vynvori_ledger.refinement_slots FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- ---- slot events: the only way a slot state changes ----------------------------------------------------------------------------
CREATE TABLE vynvori_ledger.refinement_slot_events(
  slot_event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  package_id uuid NOT NULL,
  command_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  source_version_id text NULL CONSTRAINT refinement_slot_events_source_shape CHECK (source_version_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  operation_id text NULL CONSTRAINT refinement_slot_events_operation_shape CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  delivered_version_id text NULL CONSTRAINT refinement_slot_events_delivered_shape CHECK (delivered_version_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  evidence_ref text NULL CONSTRAINT refinement_slot_events_evidence_ref CHECK (length(evidence_ref) BETWEEN 1 AND 512 AND evidence_ref ~ '^[ -~]+$'),
  closure_cause text NULL CONSTRAINT refinement_slot_events_closure_cause CHECK (closure_cause IN ('final_delivered', 'explicit_close')),
  closure_notice_version text NULL CONSTRAINT refinement_slot_events_notice_shape CHECK (length(closure_notice_version) BETWEEN 1 AND 256 AND closure_notice_version ~ '^[ -~]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refinement_slot_events_slot_fk FOREIGN KEY (slot_id, user_id) REFERENCES vynvori_ledger.refinement_slots(slot_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT refinement_slot_events_slot_package_fk FOREIGN KEY (slot_id, package_id) REFERENCES vynvori_ledger.refinement_slots(slot_id, package_id) ON DELETE RESTRICT,
  CONSTRAINT refinement_slot_events_command_fk FOREIGN KEY (command_id, user_id) REFERENCES vynvori_ledger.ledger_commands(command_id, user_id) ON DELETE RESTRICT,
  -- One slot transition per slot per command; a closure command forfeits each of the (at most two) unused slots once.
  CONSTRAINT refinement_slot_events_command_slot_unique UNIQUE (command_id, slot_id),
  CONSTRAINT refinement_slot_events_edge CHECK (vynvori_ledger.refinement_slot_edge_allowed(from_state, to_state)),
  CONSTRAINT refinement_slot_events_shape CHECK (
    (to_state IN ('skipped', 'available') AND source_version_id IS NULL AND operation_id IS NULL AND delivered_version_id IS NULL AND evidence_ref IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'pending' AND source_version_id IS NOT NULL AND operation_id IS NOT NULL AND delivered_version_id IS NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'unknown' AND source_version_id IS NULL AND operation_id IS NOT NULL AND delivered_version_id IS NULL AND evidence_ref IS NOT NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'used' AND source_version_id IS NULL AND operation_id IS NOT NULL AND delivered_version_id IS NOT NULL AND evidence_ref IS NOT NULL AND closure_cause IS NULL AND closure_notice_version IS NULL)
 OR (to_state = 'forfeited' AND source_version_id IS NULL AND operation_id IS NULL AND delivered_version_id IS NULL AND evidence_ref IS NULL AND closure_cause IS NOT NULL AND closure_notice_version IS NOT NULL))
);
CREATE TRIGGER refinement_slot_events_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.refinement_slot_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER refinement_slot_events_no_truncate BEFORE TRUNCATE ON vynvori_ledger.refinement_slot_events FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- ---- package: S5's "every UPDATE rejected" trigger gives way to the owner-checked update guard -----------------------------------
DROP TRIGGER ledger_packages_immutable ON vynvori_ledger.ledger_packages;
CREATE TRIGGER ledger_packages_no_delete BEFORE DELETE ON vynvori_ledger.ledger_packages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- BEFORE UPDATE: identity is immutable; the only update is a STATE change made by the SECURITY DEFINER apply function (depth > 1 AND
-- current_user = owner of ledger_package_events_apply()) along an S7 edge.
CREATE FUNCTION vynvori_ledger.ledger_packages_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_packages'::pg_catalog.regclass OR TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.package_id, NEW.user_id, NEW.authorization_id, NEW.created_at) IS DISTINCT FROM (OLD.package_id, OLD.user_id, OLD.authorization_id, OLD.created_at) THEN
    RAISE EXCEPTION 'package identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR pg_trigger_depth() <= 1 OR current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('vynvori_ledger.ledger_package_events_apply()'))) THEN
    RAISE EXCEPTION 'package state changes only through package events' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT vynvori_ledger.ledger_package_edge_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'illegal package transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_packages_update_guard BEFORE UPDATE ON vynvori_ledger.ledger_packages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_packages_update_guard();

-- ---- package events: binding (BEFORE INSERT, invoker rights) ----------------------------------------------------------------------
-- The command is an applied command of the same user, of the kind that owns this edge, written in THIS transaction; the package is the
-- same user's, locked, in exactly the event's from_state. Lock order wallet -> package -> slots/reservations, as in every command (A4).
CREATE FUNCTION vynvori_ledger.ledger_package_events_bind() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  expected_kind text;
  cmd record;
  ref8 bigint;
  full8 bigint;
  p record;
  r record;
  quote_version text;
  notice text;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_package_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  expected_kind := CASE
    WHEN NEW.to_state IN ('partial', 'delivered_3_of_3') THEN 'bundle_record_delivery'
    WHEN NEW.from_state = 'delivered_3_of_3' AND NEW.to_state = 'open_for_refinements' THEN 'bundle_open_refinements'
    WHEN NEW.to_state = 'closure_pending' THEN 'bundle_begin_closure'
    WHEN NEW.to_state = 'closed' THEN 'bundle_close'
    ELSE 'bundle_reopen' END;
  -- The command is an applied command of this user, of the matching kind, written by THE CURRENT TRANSACTION (xid8 widening as in 0005).
  SELECT c.command_kind, c.xmin AS x INTO cmd FROM vynvori_ledger.ledger_commands c
    WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied';
  IF NOT FOUND OR cmd.command_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'a package event must reference an applied % command', expected_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | cmd.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a package event must reference a command written in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM 1 FROM vynvori_ledger.wallets w WHERE w.user_id = NEW.user_id FOR UPDATE;
  SELECT lp.state, lp.authorization_id INTO p FROM vynvori_ledger.ledger_packages lp WHERE lp.package_id = NEW.package_id AND lp.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR p.state IS DISTINCT FROM NEW.from_state THEN
    RAISE EXCEPTION 'package not found for this user in the stated state' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.to_state = 'closure_pending' THEN
    PERFORM 1 FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id AND s.user_id = NEW.user_id ORDER BY s.ordinal FOR UPDATE;
    IF EXISTS (SELECT 1 FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id AND s.state IN ('pending', 'unknown')) THEN
      RAISE EXCEPTION 'closure cannot begin while a refinement is pending or unknown' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.begin_reason = 'final_authorized' THEN
      SELECT cr.state, cr.pre_attempt_package_state INTO r FROM vynvori_ledger.credit_reservations cr
        WHERE cr.reservation_id = NEW.final_reservation_id AND cr.user_id = NEW.user_id AND cr.original_package_id = NEW.package_id
          AND cr.operation_kind IN ('final_standard', 'final_premium') FOR UPDATE;
      IF NOT FOUND OR r.state <> 'reserved' OR r.pre_attempt_package_state IS DISTINCT FROM 'open_for_refinements' THEN
        RAISE EXCEPTION 'closure by final authorization needs a reserved final of this package that began on an open package' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;

  ELSIF NEW.to_state = 'closed' THEN
    PERFORM 1 FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id AND s.user_id = NEW.user_id ORDER BY s.ordinal FOR UPDATE;
    IF EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations cr WHERE cr.original_package_id = NEW.package_id AND cr.user_id = NEW.user_id
               AND cr.state IN ('authorization_requested', 'reserved', 'reconciliation_hold', 'operator_remedy')) THEN
      RAISE EXCEPTION 'a package cannot close while a final of it is unresolved' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.closure_cause = 'final_delivered' THEN
      SELECT cr.quote_version_id INTO quote_version FROM vynvori_ledger.credit_reservations cr
        WHERE cr.reservation_id = NEW.final_reservation_id AND cr.user_id = NEW.user_id AND cr.original_package_id = NEW.package_id
          AND cr.operation_kind IN ('final_standard', 'final_premium') AND cr.state = 'settled';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'closure by final delivery needs a settled final of this package' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations cr WHERE cr.original_package_id = NEW.package_id AND cr.user_id = NEW.user_id AND cr.state = 'settled') THEN
        RAISE EXCEPTION 'a package with a settled final closes by final delivery, not explicit close' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT la.quote_version_id INTO quote_version FROM vynvori_ledger.ledger_authorizations la WHERE la.authorization_id = p.authorization_id AND la.user_id = NEW.user_id;
    END IF;
    -- The forfeiture notice must be the one the customer was shown: the stored paid terms of the disclosing quote (the settled final's
    -- quote, or the bundle's own quote for an explicit close). A quote without that notice cannot close a package: the feature stays closed.
    SELECT lq.quote_view -> 'paidTerms' ->> 'refinementClosureNoticeVersion' INTO notice FROM vynvori_ledger.ledger_quotes lq WHERE lq.quote_version_id = quote_version AND lq.user_id = NEW.user_id;
    IF notice IS NULL OR notice IS DISTINCT FROM NEW.closure_notice_version THEN
      RAISE EXCEPTION 'the closure notice version must equal the disclosed refinement closure notice of the quote' USING ERRCODE = 'integrity_constraint_violation';
    END IF;

  ELSIF NEW.from_state = 'closure_pending' AND NEW.to_state = 'open_for_refinements' THEN
    -- doc 06 C-02 via contracts mayReopenBundleAfterUnchargedFinal: first final attempt (it began on an OPEN package), verified uncharged,
    -- release receipt durable (the release entry is visible here: committed earlier, or written by this very transaction), and no final settled.
    SELECT cr.state, cr.pre_attempt_package_state INTO r FROM vynvori_ledger.credit_reservations cr
      WHERE cr.reservation_id = NEW.final_reservation_id AND cr.user_id = NEW.user_id AND cr.original_package_id = NEW.package_id
        AND cr.operation_kind IN ('final_standard', 'final_premium') FOR UPDATE;
    IF NOT FOUND OR r.state <> 'released' OR r.pre_attempt_package_state IS DISTINCT FROM 'open_for_refinements' THEN
      RAISE EXCEPTION 'reopening needs the released first final of this package that began on an open package' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Closure must have BEGUN because of this very final (the package's latest closure_pending event is final_authorized for it): a
    -- customer's explicit close request is never reversed by an unrelated, earlier released final.
    IF NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_package_events pe WHERE pe.package_id = NEW.package_id AND pe.user_id = NEW.user_id
                   AND pe.to_state = 'closure_pending' AND pe.begin_reason = 'final_authorized' AND pe.final_reservation_id = NEW.final_reservation_id
                   AND NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_package_events pl WHERE pl.package_id = pe.package_id AND pl.user_id = pe.user_id
                                   AND pl.to_state = 'closure_pending' AND pl.created_at > pe.created_at)) THEN
      RAISE EXCEPTION 'reopening needs closure to have begun because of this final' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_entries e WHERE e.reservation_id = NEW.final_reservation_id AND e.user_id = NEW.user_id
                   AND e.entry_kind = 'release' AND e.evidence_kind = 'verified_zero_charge_failure') THEN
      RAISE EXCEPTION 'reopening needs the durable verified-zero-charge release entry of the final' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations cr WHERE cr.original_package_id = NEW.package_id AND cr.user_id = NEW.user_id
               AND cr.state IN ('authorization_requested', 'reserved', 'settled', 'reconciliation_hold', 'operator_remedy')) THEN
      RAISE EXCEPTION 'reopening needs every final of the package released: none settled and none unresolved' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_package_events_bind BEFORE INSERT ON vynvori_ledger.ledger_package_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_package_events_bind();

-- The ONLY writer of ledger_packages.state and the ONLY inserter of refinement_slots. SECURITY DEFINER: its owner must be a dedicated
-- NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE role before any rollout (S9). It re-checks user and source state in its own WHERE
-- clause. The two slots are created only on the delivered_3_of_3 -> open_for_refinements edge: a reopen after an uncharged final
-- never recreates slots, and a closed package never reopens.
CREATE FUNCTION vynvori_ledger.ledger_package_events_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_package_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE vynvori_ledger.ledger_packages lp SET state = NEW.to_state
    WHERE lp.package_id = NEW.package_id AND lp.user_id = NEW.user_id AND lp.state = NEW.from_state;
  IF NOT FOUND THEN RAISE EXCEPTION 'package transition did not apply' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.from_state = 'delivered_3_of_3' AND NEW.to_state = 'open_for_refinements' THEN
    INSERT INTO vynvori_ledger.refinement_slots(slot_id, user_id, package_id, ordinal, state)
      VALUES (pg_catalog.gen_random_uuid(), NEW.user_id, NEW.package_id, 1, 'available'), (pg_catalog.gen_random_uuid(), NEW.user_id, NEW.package_id, 2, 'available');
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER ledger_package_events_apply AFTER INSERT ON vynvori_ledger.ledger_package_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_package_events_apply();

-- DEFERRED: a package that became open for refinements commits with exactly its two slots; a package that closes commits with no
-- slot still available, skipped, pending or unknown (each is used or forfeited): no silent forfeiture and no silent survival.
CREATE FUNCTION vynvori_ledger.ledger_package_events_check_complete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_package_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.from_state = 'delivered_3_of_3' AND NEW.to_state = 'open_for_refinements' THEN
    IF (SELECT count(*) FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id) <> 2
       OR (SELECT count(DISTINCT s.ordinal) FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id) <> 2 THEN
      RAISE EXCEPTION 'an open package has exactly its two refinement slots' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.to_state = 'closed' THEN
    IF EXISTS (SELECT 1 FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id AND s.state NOT IN ('used', 'forfeited')) THEN
      RAISE EXCEPTION 'a closed package has no refinement slot left unresolved' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM vynvori_ledger.refinement_slots s WHERE s.package_id = NEW.package_id AND s.state = 'forfeited'
               AND (s.closure_cause IS DISTINCT FROM NEW.closure_cause OR s.closure_notice_version IS DISTINCT FROM NEW.closure_notice_version)) THEN
      RAISE EXCEPTION 'a forfeited slot carries the closing event''s cause and notice' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER ledger_package_events_check_complete AFTER INSERT ON vynvori_ledger.ledger_package_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_package_events_check_complete();

-- ---- slots: insert only by the package-event definer; update only by the slot-event definer ----------------------------------------
CREATE FUNCTION vynvori_ledger.refinement_slots_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.refinement_slots'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF pg_trigger_depth() <= 1 OR current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('vynvori_ledger.ledger_package_events_apply()'))) THEN
    RAISE EXCEPTION 'refinement slots are created only by the package open transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> 'available' OR NEW.source_version_id IS NOT NULL OR NEW.operation_id IS NOT NULL OR NEW.delivered_version_id IS NOT NULL
     OR NEW.closure_cause IS NOT NULL OR NEW.closure_notice_version IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_packages lp WHERE lp.package_id = NEW.package_id AND lp.user_id = NEW.user_id AND lp.state = 'open_for_refinements') THEN
    RAISE EXCEPTION 'a slot is created available, empty, on an open package' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER refinement_slots_insert_guard BEFORE INSERT ON vynvori_ledger.refinement_slots FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.refinement_slots_insert_guard();

CREATE FUNCTION vynvori_ledger.refinement_slots_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.refinement_slots'::pg_catalog.regclass OR TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.slot_id, NEW.user_id, NEW.package_id, NEW.ordinal, NEW.created_at) IS DISTINCT FROM (OLD.slot_id, OLD.user_id, OLD.package_id, OLD.ordinal, OLD.created_at) THEN
    RAISE EXCEPTION 'slot identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state
     OR pg_trigger_depth() <= 1 OR current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('vynvori_ledger.refinement_slot_events_apply()'))) THEN
    RAISE EXCEPTION 'slot state changes only through slot events' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT vynvori_ledger.refinement_slot_edge_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'illegal slot transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Once bound, the source version and the operation never change (the slot is bound to one source and one refinement operation).
  IF (OLD.source_version_id IS NOT NULL AND NEW.source_version_id IS DISTINCT FROM OLD.source_version_id)
     OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id) THEN
    RAISE EXCEPTION 'a slot''s source version and operation are bound once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER refinement_slots_update_guard BEFORE UPDATE ON vynvori_ledger.refinement_slots FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.refinement_slots_update_guard();

-- ---- slot events: binding (BEFORE INSERT, invoker rights) -----------------------------------------------------------------------
CREATE FUNCTION vynvori_ledger.refinement_slot_events_bind() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  expected_kind text;
  cmd record;
  ref8 bigint;
  full8 bigint;
  p record;
  s record;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.refinement_slot_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  expected_kind := CASE NEW.to_state
    WHEN 'skipped' THEN 'refinement_skip' WHEN 'available' THEN 'refinement_restore' WHEN 'pending' THEN 'refinement_pending'
    WHEN 'unknown' THEN 'refinement_unknown' WHEN 'used' THEN 'refinement_consume' ELSE 'bundle_close' END;
  SELECT c.command_kind, c.xmin AS x INTO cmd FROM vynvori_ledger.ledger_commands c
    WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied';
  IF NOT FOUND OR cmd.command_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'a slot event must reference an applied % command', expected_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | cmd.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a slot event must reference a command written in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM 1 FROM vynvori_ledger.wallets w WHERE w.user_id = NEW.user_id FOR UPDATE;
  SELECT lp.state INTO p FROM vynvori_ledger.ledger_packages lp WHERE lp.package_id = NEW.package_id AND lp.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package not found for this user' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT rs.state, rs.operation_id, rs.source_version_id INTO s FROM vynvori_ledger.refinement_slots rs
    WHERE rs.slot_id = NEW.slot_id AND rs.user_id = NEW.user_id AND rs.package_id = NEW.package_id FOR UPDATE;
  IF NOT FOUND OR s.state IS DISTINCT FROM NEW.from_state THEN
    RAISE EXCEPTION 'slot not found for this user in the stated state' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- skip/restore/pending/unknown/consume only while the package is open; a forfeiture only while closure is pending (and only together
  -- with the closing package event, see the deferred check below). closure_pending forbids silent consumption and silent forfeiture.
  IF NEW.to_state = 'forfeited' THEN
    IF p.state <> 'closure_pending' THEN RAISE EXCEPTION 'a slot is forfeited only while closure is pending' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF p.state <> 'open_for_refinements' THEN
    RAISE EXCEPTION 'slot changes are allowed only while the package is open for refinements' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.to_state = 'pending' AND s.source_version_id IS NOT NULL AND s.source_version_id IS DISTINCT FROM NEW.source_version_id THEN
    RAISE EXCEPTION 'the slot is bound to a different source version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.to_state IN ('unknown', 'used') AND s.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'the event must name the slot''s own refinement operation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER refinement_slot_events_bind BEFORE INSERT ON vynvori_ledger.refinement_slot_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.refinement_slot_events_bind();

-- The ONLY writer of refinement_slots state and fields. SECURITY DEFINER (see the header); it re-checks user, package and source state.
CREATE FUNCTION vynvori_ledger.refinement_slot_events_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.refinement_slot_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE vynvori_ledger.refinement_slots rs SET
    state = NEW.to_state,
    source_version_id = COALESCE(rs.source_version_id, NEW.source_version_id),
    operation_id = COALESCE(rs.operation_id, NEW.operation_id),
    delivered_version_id = COALESCE(rs.delivered_version_id, NEW.delivered_version_id),
    closure_cause = COALESCE(rs.closure_cause, NEW.closure_cause),
    closure_notice_version = COALESCE(rs.closure_notice_version, NEW.closure_notice_version)
  WHERE rs.slot_id = NEW.slot_id AND rs.user_id = NEW.user_id AND rs.package_id = NEW.package_id AND rs.state = NEW.from_state;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot transition did not apply' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER refinement_slot_events_apply AFTER INSERT ON vynvori_ledger.refinement_slot_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.refinement_slot_events_apply();

-- DEFERRED: a forfeiture commits only together with the closing package event of the same command (never a silent forfeiture).
CREATE FUNCTION vynvori_ledger.refinement_slot_events_check_complete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.refinement_slot_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.to_state = 'forfeited' AND NOT EXISTS (
       SELECT 1 FROM vynvori_ledger.ledger_package_events pe
       WHERE pe.command_id = NEW.command_id AND pe.user_id = NEW.user_id AND pe.package_id = NEW.package_id AND pe.to_state = 'closed'
         AND pe.closure_cause = NEW.closure_cause AND pe.closure_notice_version = NEW.closure_notice_version) THEN
    RAISE EXCEPTION 'a slot is forfeited only by the closing event of its package, with its cause and notice' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER refinement_slot_events_check_complete AFTER INSERT ON vynvori_ledger.refinement_slot_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.refinement_slot_events_check_complete();

REVOKE ALL ON FUNCTION vynvori_ledger.ledger_packages_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_package_events_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_package_events_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_package_events_check_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.refinement_slots_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.refinement_slots_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.refinement_slot_events_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.refinement_slot_events_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.refinement_slot_events_check_complete() FROM PUBLIC;
