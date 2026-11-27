-- ROLLBACK for 0006_vendor_cost_evidence.sql (ADR-0021, M7 S6). NOT executed by any runner; an operator runs it by hand on a
-- disposable database, or on a real one only after a verified backup and after confirming `SELECT current_database()`.
-- It refuses while 0006 is not journaled, while a later migration is journaled (roll those back first, in reverse order), while ANY
-- row exists in vendor_cost_evidence, and while any settle or hold entry (or a settled / held reservation) exists. Those rows are
-- append-only or guarded, so removing real settlement data means RESTORE FROM BACKUP, not running this script. It drops the
-- vendor_cost_evidence table (its two triggers go with it), restores the three S5 function bodies VERBATIM from
-- 0005_reservations.sql (the reservation definer keeps SECURITY DEFINER, its owner and its ACL: CREATE OR REPLACE preserves both),
-- and re-adds S5's temporary ledger_entries_s5_kinds constraint (grant, reserve, release). No GRANT; no CASCADE; no DELETE of ledger
-- rows. One DO block: a failed guard can never be followed by a surviving DROP even under plain `psql -f` without ON_ERROR_STOP.
-- 0002's reject_mutation() is NOT dropped here: it is owned by 0002. After an S9 re-own of ledger_entries_apply_to_reservation(),
-- re-own it back to the migration owner first (CREATE OR REPLACE needs the function owner), as for 0002 and 0005.
DO $rollback$
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '4s', true);
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(742110, 7); -- same lock as the runner: never races an apply
  IF pg_catalog.to_regnamespace('vynvori_ledger_migrations') IS NULL OR NOT EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file = '0006_vendor_cost_evidence.sql') THEN
    RAISE EXCEPTION '0006_vendor_cost_evidence is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM vynvori_ledger_migrations.applied WHERE file > '0006_vendor_cost_evidence.sql') THEN
    RAISE EXCEPTION 'refusing rollback: a later ledger migration is applied; roll it back first';
  END IF;
  IF pg_catalog.to_regclass('vynvori_ledger.vendor_cost_evidence') IS NULL OR pg_catalog.to_regclass('vynvori_ledger.credit_reservations') IS NULL THEN
    RAISE EXCEPTION 'schema drift: 0006 is journaled but a table is missing';
  END IF;
  -- Block writers BEFORE the emptiness check: otherwise a row committed after the check but before the DROP would be destroyed silently.
  LOCK TABLE vynvori_ledger.ledger_entries, vynvori_ledger.credit_reservations, vynvori_ledger.vendor_cost_evidence IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM vynvori_ledger.vendor_cost_evidence) OR EXISTS (SELECT 1 FROM vynvori_ledger.ledger_entries WHERE entry_kind IN ('settle', 'hold'))
     OR EXISTS (SELECT 1 FROM vynvori_ledger.credit_reservations WHERE state IN ('settled', 'reconciliation_hold')) THEN
    RAISE EXCEPTION 'refusing rollback: rows exist in the settlement tables; ledger data is restored from backup, never deleted';
  END IF;
  DROP TABLE vynvori_ledger.vendor_cost_evidence;
  -- ---- the three S5 bodies, verbatim from 0005_reservations.sql (only CREATE became CREATE OR REPLACE) ----
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
  -- Lock order is always wallet -> reservation, as in every TypeScript command (A4), so raw-SQL writers cannot deadlock with them.
  PERFORM 1 FROM vynvori_ledger.wallets w WHERE w.user_id = NEW.user_id FOR UPDATE;
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
  ELSE
    RAISE EXCEPTION 'entry kind % is not available yet', NEW.entry_kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation transition did not apply' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;
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

  ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_s5_kinds CHECK (entry_kind IN ('grant', 'reserve', 'release'));
  DELETE FROM vynvori_ledger_migrations.applied WHERE file = '0006_vendor_cost_evidence.sql';
END
$rollback$;
