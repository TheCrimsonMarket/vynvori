-- 0004_promo_claims (ADR-0021, M7 S4). Promo-claim uniqueness per verified issuer + subject, and its append-only event trail.
-- Additive: creates objects in vynvori_ledger only. No GRANT; the only REVOKE is function-level FROM PUBLIC. No SECURITY DEFINER
-- function is added here (the migration set keeps exactly S2's one). No rows are inserted. Nothing in vynvori_identity is
-- altered, and no wallet, ledger entry, quote or reservation object is read or written by anything created here: a promo claim is
-- an ENTITLEMENT, never a wallet debit (ADR-0021 D8; promo quotes are 0/0).
--
-- Design (ADR-0021 S4 addendum):
--   * promo_claims holds at most ONE row per verified identity, ever: UNIQUE (issuer, subject) plus a composite FK to
--     vynvori_identity.profiles(issuer, subject). The two-device race resolves on that unique index. A guest has no profile row, so
--     no claim row can exist for one. A verified-uncharged failure is NOT re-offered (founder ruling Q2): the row stays.
--   * The claim STATE changes only by inserting a row into the append-only promo_claim_events. promo_claim_events_apply() (AFTER
--     INSERT) is the only writer of promo_claims.state / event_seq. promo_claims_update_guard() rejects every other UPDATE.
--   * The guard is deliberately NOT a trigger-depth check alone (ADR-0021 D3, S2 addendum: a pg_temp trigger reaches depth 2).
--     Depth > 1 is kept as a first line; the binding check is by CONTENT: an UPDATE may only move (state, event_seq) from the
--     claim's current values to exactly the values recorded by the NEXT row of the append-only event trail, which itself passed
--     the graph edge check and the evidence matrix below. A bypass of the depth check therefore cannot produce a state that is not
--     in the trail. No SECURITY DEFINER is used because nothing here moves credit; the hard gate on the definer owner role stays
--     with ledger_entries_apply_to_wallet() and is founder-executed, never in a migration.
--   * The state graph is PLANE_C_PROMO_GRAPH (packages/contracts/src/state-machines.ts). promo_claim_edge_allowed() restates its
--     edges; a test compares all 25 state pairs against canTransitionPlaneCPromo so the two cannot drift silently.
--   * Evidence gating, like D6: every event carries a typed evidence_kind and evidence_ref, and the (from, to, evidence_kind)
--     matrix is a CHECK. consumed needs persisted-delivery evidence, verified_uncharged_failure needs verified-zero-charge
--     evidence, claim_unknown needs unknown-outcome evidence, and claim_unknown -> consumed / verified_uncharged_failure needs
--     authoritative RECONCILIATION evidence (reconciled_delivered / reconciled_uncharged_failure), never the first-hand kinds.
--     The operation id of an event is bound to the claim's by composite FK.

CREATE FUNCTION vynvori_ledger.promo_claim_edge_allowed(edge_from text, edge_to text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT (edge_from, edge_to) IN (
    ('eligible', 'claim_reserved'),
    ('claim_reserved', 'consumed'), ('claim_reserved', 'verified_uncharged_failure'), ('claim_reserved', 'claim_unknown'),
    ('claim_unknown', 'consumed'), ('claim_unknown', 'verified_uncharged_failure'))
$fn$;

CREATE TABLE vynvori_ledger.promo_claims(
  claim_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT,
  issuer text NOT NULL,
  subject text NOT NULL,
  operation_id text NOT NULL CONSTRAINT promo_claims_operation_id_shape CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL CONSTRAINT promo_claims_state CHECK (state IN ('eligible', 'claim_reserved', 'consumed', 'verified_uncharged_failure', 'claim_unknown')),
  event_seq integer NOT NULL DEFAULT 0 CONSTRAINT promo_claims_event_seq_bounds CHECK (event_seq >= 0 AND event_seq <= 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_claims_identity_unique UNIQUE (issuer, subject),
  CONSTRAINT promo_claims_user_unique UNIQUE (user_id),
  CONSTRAINT promo_claims_operation_unique UNIQUE (operation_id),
  CONSTRAINT promo_claims_claim_user UNIQUE (claim_id, user_id),
  CONSTRAINT promo_claims_claim_operation UNIQUE (claim_id, operation_id),
  CONSTRAINT promo_claims_profile_identity_fk FOREIGN KEY (issuer, subject) REFERENCES vynvori_identity.profiles(issuer, subject) ON DELETE RESTRICT,
  CONSTRAINT promo_claims_state_seq_shape CHECK ((state = 'eligible') = (event_seq = 0))
);

-- BEFORE INSERT: a claim row is born 'eligible' with no events, and its user_id must be the profile that owns (issuer, subject).
CREATE FUNCTION vynvori_ledger.promo_claims_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.promo_claims'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> 'eligible' OR NEW.event_seq <> 0 THEN
    RAISE EXCEPTION 'a promo claim is created eligible; its state changes only through promo_claim_events' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vynvori_identity.profiles p WHERE p.id = NEW.user_id AND p.issuer = NEW.issuer AND p.subject = NEW.subject) THEN
    RAISE EXCEPTION 'user_id does not own this issuer and subject' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER promo_claims_insert_guard BEFORE INSERT ON vynvori_ledger.promo_claims FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.promo_claims_insert_guard();

-- BEFORE UPDATE: the only legal update moves (state, event_seq) from the current values to the values of the next trail row.
CREATE FUNCTION vynvori_ledger.promo_claims_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.promo_claims'::pg_catalog.regclass OR TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'promo claim state changes only through promo_claim_events' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.claim_id <> OLD.claim_id OR NEW.user_id <> OLD.user_id OR NEW.issuer <> OLD.issuer OR NEW.subject <> OLD.subject
     OR NEW.operation_id <> OLD.operation_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'promo claim identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT vynvori_ledger.promo_claim_edge_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'illegal promo claim transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.event_seq <> OLD.event_seq + 1 OR NOT EXISTS (
       SELECT 1 FROM vynvori_ledger.promo_claim_events e
        WHERE e.claim_id = OLD.claim_id AND e.seq = NEW.event_seq AND e.from_state = OLD.state AND e.to_state = NEW.state) THEN
    RAISE EXCEPTION 'promo claim state must equal the next recorded event' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER promo_claims_update_guard BEFORE UPDATE ON vynvori_ledger.promo_claims FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.promo_claims_update_guard();
CREATE TRIGGER promo_claims_no_delete BEFORE DELETE ON vynvori_ledger.promo_claims FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER promo_claims_no_truncate BEFORE TRUNCATE ON vynvori_ledger.promo_claims FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.promo_claim_events(
  event_id uuid PRIMARY KEY,
  claim_id uuid NOT NULL,
  user_id uuid NOT NULL,
  operation_id text NOT NULL,
  seq integer NOT NULL CONSTRAINT promo_claim_events_seq_bounds CHECK (seq >= 1 AND seq <= 8),
  from_state text NOT NULL,
  to_state text NOT NULL,
  evidence_kind text NOT NULL,
  evidence_ref text NOT NULL CONSTRAINT promo_claim_events_evidence_ref_shape CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,255}$'),
  command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_claim_events_claim_user_fk FOREIGN KEY (claim_id, user_id) REFERENCES vynvori_ledger.promo_claims(claim_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT promo_claim_events_claim_operation_fk FOREIGN KEY (claim_id, operation_id) REFERENCES vynvori_ledger.promo_claims(claim_id, operation_id) ON DELETE RESTRICT,
  CONSTRAINT promo_claim_events_command_fk FOREIGN KEY (command_id, user_id) REFERENCES vynvori_ledger.ledger_commands(command_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT promo_claim_events_claim_seq UNIQUE (claim_id, seq),
  CONSTRAINT promo_claim_events_claim_from UNIQUE (claim_id, from_state),
  CONSTRAINT promo_claim_events_command_unique UNIQUE (command_id),
  CONSTRAINT promo_claim_events_edge CHECK (vynvori_ledger.promo_claim_edge_allowed(from_state, to_state)),
  CONSTRAINT promo_claim_events_evidence_matrix CHECK (
    (from_state = 'eligible'       AND to_state = 'claim_reserved'             AND evidence_kind = 'claim_requested')
 OR (from_state = 'claim_reserved' AND to_state = 'consumed'                   AND evidence_kind = 'persisted_delivered')
 OR (from_state = 'claim_reserved' AND to_state = 'verified_uncharged_failure' AND evidence_kind = 'verified_zero_charge_failure')
 OR (from_state = 'claim_reserved' AND to_state = 'claim_unknown'              AND evidence_kind IN ('outcome_unknown', 'persistence_failed_under_review'))
 OR (from_state = 'claim_unknown'  AND to_state = 'consumed'                   AND evidence_kind = 'reconciled_delivered')
 OR (from_state = 'claim_unknown'  AND to_state = 'verified_uncharged_failure' AND evidence_kind = 'reconciled_uncharged_failure'))
);

-- BEFORE INSERT: the event must continue the claim's trail exactly (next seq, from = current state) and belong to an applied
-- command of the same user. The claim row is locked FOR UPDATE so raw writers outside runLedgerCommand serialize too.
CREATE FUNCTION vynvori_ledger.promo_claim_events_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  claim_state text;
  claim_seq integer;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.promo_claim_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.state, c.event_seq INTO claim_state, claim_seq FROM vynvori_ledger.promo_claims c WHERE c.claim_id = NEW.claim_id AND c.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promo claim event for an unknown claim' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.from_state <> claim_state OR NEW.seq <> claim_seq + 1 THEN
    RAISE EXCEPTION 'promo claim event does not continue the claim trail' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT vynvori_ledger.promo_claim_edge_allowed(NEW.from_state, NEW.to_state) THEN
    RAISE EXCEPTION 'illegal promo claim transition % -> %', NEW.from_state, NEW.to_state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vynvori_ledger.ledger_commands lc WHERE lc.command_id = NEW.command_id AND lc.user_id = NEW.user_id AND lc.outcome = 'applied') THEN
    RAISE EXCEPTION 'a promo claim event must reference an applied command of the same user' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER promo_claim_events_check BEFORE INSERT ON vynvori_ledger.promo_claim_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.promo_claim_events_check();

-- AFTER INSERT: the only writer of promo_claims.state / event_seq. It runs at trigger depth 1, so its UPDATE fires the claim guard at depth 2.
CREATE FUNCTION vynvori_ledger.promo_claim_events_apply() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.promo_claim_events'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE vynvori_ledger.promo_claims c SET state = NEW.to_state, event_seq = NEW.seq WHERE c.claim_id = NEW.claim_id AND c.user_id = NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'promo claim missing for event' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER promo_claim_events_apply AFTER INSERT ON vynvori_ledger.promo_claim_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.promo_claim_events_apply();

CREATE TRIGGER promo_claim_events_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.promo_claim_events FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER promo_claim_events_no_truncate BEFORE TRUNCATE ON vynvori_ledger.promo_claim_events FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- promo_claim_edge_allowed(text, text) is deliberately NOT revoked from PUBLIC: it is a pure IMMUTABLE boolean over two literals (no table access,
-- pinned search_path), and a CHECK constraint or trigger body calls it as the INVOKER, so a revoke would force an extra EXECUTE grant onto the
-- runtime role for nothing. The four trigger functions are revoked like every other ledger function.
REVOKE ALL ON FUNCTION vynvori_ledger.promo_claims_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.promo_claims_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.promo_claim_events_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.promo_claim_events_apply() FROM PUBLIC;
