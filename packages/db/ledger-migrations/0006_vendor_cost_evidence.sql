-- 0006_vendor_cost_evidence (ADR-0021, M7 S6). Settle and reconciliation hold for credit reservations, and an ISOLATED internal
-- record of vendor-cost evidence that can never move a credit.
-- Additive: creates one table in vynvori_ledger, drops S5's TEMPORARY constraint ledger_entries_s5_kinds (S5 addendum: "S6
-- widens it"; ledger_entries_kind from 0002 still limits entries to grant/reserve/release/settle/hold), and replaces the bodies of
-- three S5 functions to add exactly two reservation edges: reserved -> settled and reserved -> reconciliation_hold. No GRANT; the
-- only REVOKE is function-level FROM PUBLIC; no role, no owner change, no rows inserted, nothing in vynvori_identity referenced,
-- no Medusa object referenced. Its rollback restores the three S5 bodies verbatim and re-adds ledger_entries_s5_kinds.
--
-- Privilege model B (ADR-0021 D3, registry hard gate "S5 reservation guards"): reservation state is still written ONLY by the
-- SECURITY DEFINER function ledger_entries_apply_to_reservation() (re-declared SECURITY DEFINER below: CREATE OR REPLACE keeps the
-- owner and the ACL but would otherwise reset the security attribute). credit_reservations_update_guard() still rejects every state
-- change unless BOTH pg_trigger_depth() > 1 AND current_user is the OWNER OF THAT FUNCTION, compared by name with pg_get_userbyid
-- (never a regrole cast). No new SECURITY DEFINER function is added: the migration set keeps exactly two. CREATE OR REPLACE needs
-- the function owner, so after an S9 re-own a migration that replaces the definer must run under the re-own procedure.
--
-- D6 (evidence-gated, never auto-resolved): settle needs Plane B `persisted_delivered` evidence, hold needs `outcome_unknown` or
-- `persistence_failed_under_review`; both need a dispatched reservation (workflow_ref recorded) and a command of the matching kind
-- written in THIS transaction. A settle consumes EXACTLY the frozen charge_units and returns hold_units - charge_units to
-- `available` in the same entry; a hold moves the full hold_units to `held_for_review`. NOTHING leaves reconciliation_hold in W1:
-- no entry kind, no edge and no function does it (hold resolution belongs to the remedy milestone, blocked per doc 06).
--
-- Vendor-cost isolation (plan S6, D6): vendor_cost_evidence has NO foreign key to and is referenced by NO foreign key from any
-- ledger table; its only triggers are 0002's reject_mutation() (append-only); no ledger trigger or function reads it. A vendor
-- invoice or usage record therefore cannot settle, release, hold or debit anything. amount_usd_micros is an exact integer number of
-- millionths of a US dollar (internal.ts privateVendorCostUsd = amount_usd_micros / 1e6 for display only; the reverse conversion,
-- which would need rounding, is never done by the ledger). The ledger never converts USD into credits (no rate card exists).

-- ---- entry kinds: S5's temporary set gives way to the full 0002 set ----------------------------------------------------------
ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s5_kinds;

-- ---- entry <-> reservation binding, now with settle and hold ---------------------------------------------------------------
-- BEFORE INSERT on ledger_entries (reservation kinds only): unchanged for reserve and release; settle and hold as described above.
CREATE OR REPLACE FUNCTION vynvori_ledger.ledger_entries_bind_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
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
  IF NEW.entry_kind NOT IN ('reserve', 'release', 'settle', 'hold') THEN
    RAISE EXCEPTION 'entry kind % is not available', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.command_kind, c.xmin AS x INTO cmd FROM vynvori_ledger.ledger_commands c
    WHERE c.command_id = NEW.command_id AND c.user_id = NEW.user_id AND c.outcome = 'applied';
  expected_kind := CASE NEW.entry_kind WHEN 'reserve' THEN 'reservation_authorize' WHEN 'release' THEN 'reservation_release'
    WHEN 'settle' THEN 'reservation_settle' ELSE 'reservation_hold' END;
  IF NOT FOUND OR cmd.command_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION 'a % entry must reference an applied command of the matching kind', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  ref8 := pg_catalog.pg_current_xact_id()::text::bigint;
  full8 := ((ref8 >> 32) << 32) | cmd.x::text::bigint;
  IF full8 > ref8 + 2147483648 THEN full8 := full8 - 4294967296; ELSIF full8 < ref8 - 2147483648 THEN full8 := full8 + 4294967296; END IF;
  IF pg_catalog.pg_xact_status(full8::text::xid8) IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'a reservation entry must reference a command written in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Lock order is always wallet -> reservation, as in every TypeScript command (A4), so raw-SQL writers cannot deadlock with them.
  PERFORM 1 FROM vynvori_ledger.wallets w WHERE w.user_id = NEW.user_id FOR UPDATE;
  SELECT cr.state, cr.hold_units, cr.charge_units, cr.authorization_id, cr.workflow_ref INTO r FROM vynvori_ledger.credit_reservations cr
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
  ELSIF NEW.entry_kind = 'release' THEN
    IF r.state <> 'reserved' OR r.workflow_ref IS NULL OR NEW.delta_available IS DISTINCT FROM r.hold_units
       OR NEW.evidence_kind <> 'verified_zero_charge_failure' OR length(NEW.evidence_ref) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'release entry does not match its reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.entry_kind = 'settle' THEN
    -- The shape CHECK already forces delta_available + delta_consumed = -delta_reserved; all three are pinned here anyway.
    IF r.state <> 'reserved' OR r.workflow_ref IS NULL OR NEW.delta_reserved IS DISTINCT FROM -r.hold_units
       OR NEW.delta_consumed IS DISTINCT FROM r.charge_units OR NEW.delta_available IS DISTINCT FROM r.hold_units - r.charge_units
       OR NEW.evidence_kind <> 'persisted_delivered' OR length(NEW.evidence_ref) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'settle entry does not match its reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF r.state <> 'reserved' OR r.workflow_ref IS NULL OR NEW.delta_held IS DISTINCT FROM r.hold_units
       OR NEW.evidence_kind NOT IN ('outcome_unknown', 'persistence_failed_under_review') OR length(NEW.evidence_ref) NOT BETWEEN 1 AND 512 THEN
      RAISE EXCEPTION 'hold entry does not match its reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- The ONLY writer of reservation state. SECURITY DEFINER: its owner must be a dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS,
-- NOCREATEROLE role before any rollout (S9). It touches credit_reservations only, and re-checks user, source state and units in
-- its own WHERE clause, so it can never move a reservation along an edge the binding trigger did not approve.
CREATE OR REPLACE FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
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
  ELSIF NEW.entry_kind = 'settle' THEN
    UPDATE vynvori_ledger.credit_reservations r SET state = 'settled'
      WHERE r.reservation_id = NEW.reservation_id AND r.user_id = NEW.user_id AND r.state = 'reserved' AND r.workflow_ref IS NOT NULL
        AND r.hold_units = -NEW.delta_reserved AND r.charge_units = NEW.delta_consumed;
  ELSIF NEW.entry_kind = 'hold' THEN
    UPDATE vynvori_ledger.credit_reservations r SET state = 'reconciliation_hold'
      WHERE r.reservation_id = NEW.reservation_id AND r.user_id = NEW.user_id AND r.state = 'reserved' AND r.workflow_ref IS NOT NULL AND r.hold_units = NEW.delta_held;
  ELSE
    RAISE EXCEPTION 'entry kind % is not available', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation transition did not apply' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;

-- BEFORE UPDATE: identity and units are immutable. A STATE change only through the SECURITY DEFINER apply function (depth > 1 AND
-- current_user = owner of ledger_entries_apply_to_reservation()) and only along the W1 edges: authorization_requested -> reserved,
-- reserved -> released | settled | reconciliation_hold. Nothing leaves released, settled or reconciliation_hold, and nothing enters
-- operator_remedy (D2). The only direct update is recording the workflow reference once (NULL -> value) on a reserved reservation.
CREATE OR REPLACE FUNCTION vynvori_ledger.credit_reservations_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
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
       OR NOT ((OLD.state = 'authorization_requested' AND NEW.state = 'reserved')
            OR (OLD.state = 'reserved' AND NEW.state IN ('released', 'settled', 'reconciliation_hold'))) THEN
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

-- ---- vendor-cost evidence: internal, append-only, isolated from every ledger table ----------------------------------------
-- No user column: vendor cost is a business-internal fact about a provider operation, never a customer-owned row and never part of
-- a customer projection (FORBIDDEN_PUBLIC_FIELDS lists privateVendorCostUsd and vendorCostEvidence). reservation_id is an optional
-- reconciliation hint WITHOUT a foreign key; nothing checks it against credit_reservations, by design (no ledger interaction).
-- One row per (operation, evidence kind, evidence reference): the natural key makes a re-delivered record an idempotent no-op.
CREATE TABLE vynvori_ledger.vendor_cost_evidence(
  evidence_id uuid PRIMARY KEY,
  operation_id text NOT NULL CONSTRAINT vendor_cost_evidence_operation_id_shape CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reservation_id uuid NULL,
  evidence_kind text NOT NULL CONSTRAINT vendor_cost_evidence_kind CHECK (evidence_kind IN ('usage', 'invoice', 'unknown')),
  evidence_ref text NOT NULL CONSTRAINT vendor_cost_evidence_ref_shape CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  amount_usd_micros bigint NULL CONSTRAINT vendor_cost_evidence_amount_bounds CHECK (amount_usd_micros >= 0 AND amount_usd_micros <= 9007199254740991),
  recorded_by text NOT NULL CONSTRAINT vendor_cost_evidence_component_shape CHECK (recorded_by ~ '^[a-z][a-z0-9_-]{0,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- An "unknown" vendor cost carries no amount; usage and invoice evidence may carry one, or none if the vendor reported none.
  CONSTRAINT vendor_cost_evidence_unknown_has_no_amount CHECK (evidence_kind <> 'unknown' OR amount_usd_micros IS NULL),
  CONSTRAINT vendor_cost_evidence_natural_key UNIQUE (operation_id, evidence_kind, evidence_ref)
);
CREATE TRIGGER vendor_cost_evidence_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.vendor_cost_evidence FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER vendor_cost_evidence_no_truncate BEFORE TRUNCATE ON vynvori_ledger.vendor_cost_evidence FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- CREATE OR REPLACE keeps the existing ACL (0005 already revoked these from PUBLIC); repeated here so the file states it itself.
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_bind_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.credit_reservations_update_guard() FROM PUBLIC;
