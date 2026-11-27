-- 0003_quotes (ADR-0021, M7 S3). Versioned quotes, insert-only lineage anchor, frozen per-operation allocations.
-- Additive: creates objects in vynvori_ledger only. No GRANT; the only REVOKE is function-level FROM PUBLIC. No SECURITY
-- DEFINER function is added here (the migration set keeps exactly one: S2's ledger_entries_apply_to_wallet()). No rows are
-- inserted. Nothing in vynvori_identity is altered. No reservation, authorization, price value or PricePolicyPort lives here.
--
-- Design (ADR-0021 S3 addendum): every quote command (issueQuote, renewQuote) is a ledger COMMAND of the quote owner run
-- through runLedgerCommand, which locks the user's wallet row FOR UPDATE first. All of one user's quote operations therefore
-- serialize on that wallet lock; there is NO lineage lock and NO mutable lineage pointer here. ledger_quote_lineages is an
-- INSERT-ONLY anchor binding a quote_id to exactly one owning user, forever. "Latest version" is DERIVED (max(version_no))
-- under the wallet lock, never stored. The version-contiguity trigger and UNIQUE(quote_id, version_no) are a fail-safe
-- backstop independent of the lock (ADR-0021 S3 addendum A2): two raw connections racing to insert version k+1 outside
-- runLedgerCommand can produce at most one winner, never a duplicate, never a gap.

CREATE TABLE vynvori_ledger.ledger_quote_lineages(
  quote_id text PRIMARY KEY CONSTRAINT ledger_quote_lineages_quote_id_shape CHECK (quote_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  user_id uuid NOT NULL REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_quote_lineages_quote_user UNIQUE (quote_id, user_id)
);
CREATE TRIGGER ledger_quote_lineages_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_quote_lineages FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_quote_lineages_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_quote_lineages FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.ledger_quotes(
  quote_version_id text PRIMARY KEY CONSTRAINT ledger_quotes_version_id_shape CHECK (quote_version_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  quote_id text NOT NULL,
  version_no integer NOT NULL CONSTRAINT ledger_quotes_version_no_bounds CHECK (version_no >= 1),
  user_id uuid NOT NULL,
  operation_kind text NOT NULL CONSTRAINT ledger_quotes_operation_kind CHECK (operation_kind IN ('concept_bundle_3x2', 'promo_single_preview', 'final_standard', 'final_premium')),
  model_ref text NOT NULL CONSTRAINT ledger_quotes_model_ref_shape CHECK (length(model_ref) BETWEEN 1 AND 4096),
  max_charge_units bigint NOT NULL CONSTRAINT ledger_quotes_max_charge_bounds CHECK (max_charge_units >= 0 AND max_charge_units <= 9007199254740991),
  credits_quoted bigint NOT NULL CONSTRAINT ledger_quotes_credits_quoted_bounds CHECK (credits_quoted >= 0 AND credits_quoted <= 9007199254740991),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  price_version text NOT NULL CONSTRAINT ledger_quotes_price_version_shape CHECK (length(price_version) BETWEEN 1 AND 256),
  capability_snapshot_id text NOT NULL CONSTRAINT ledger_quotes_capability_snapshot_shape CHECK (length(capability_snapshot_id) BETWEEN 1 AND 256),
  consent_text_version text NOT NULL CONSTRAINT ledger_quotes_consent_text_version_shape CHECK (length(consent_text_version) BETWEEN 1 AND 256),
  quote_view jsonb NOT NULL,
  content_sha256 char(64) NOT NULL CONSTRAINT ledger_quotes_content_sha256_shape CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_quotes_lineage_fk FOREIGN KEY (quote_id, user_id) REFERENCES vynvori_ledger.ledger_quote_lineages(quote_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ledger_quotes_quote_version UNIQUE (quote_id, version_no),
  CONSTRAINT ledger_quotes_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT ledger_quotes_credits_within_hold CHECK (credits_quoted <= max_charge_units),
  CONSTRAINT ledger_quotes_promo_shape CHECK (
    (operation_kind = 'promo_single_preview' AND max_charge_units = 0 AND credits_quoted = 0)
 OR (operation_kind <> 'promo_single_preview' AND max_charge_units > 0 AND credits_quoted > 0))
);

-- BEFORE INSERT: version_no must be exactly the next contiguous number for this quote_id (no gaps, no reuse), and
-- operation_kind must stay the same across all versions of one quote_id. Safe under the wallet lock (same-user quote
-- commands serialize there); UNIQUE(quote_id, version_no) is the independent backstop if that lock is ever bypassed.
CREATE FUNCTION vynvori_ledger.ledger_quotes_check_version() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  expected integer;
  prior_kind text;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'vynvori_ledger.ledger_quotes'::pg_catalog.regclass OR TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(max(q.version_no), 0) + 1 INTO expected FROM vynvori_ledger.ledger_quotes q WHERE q.quote_id = NEW.quote_id;
  IF NEW.version_no <> expected THEN
    RAISE EXCEPTION 'quote version must be contiguous: expected %, got %', expected, NEW.version_no USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF expected > 1 THEN
    SELECT q.operation_kind INTO prior_kind FROM vynvori_ledger.ledger_quotes q WHERE q.quote_id = NEW.quote_id AND q.version_no = 1;
    IF prior_kind IS DISTINCT FROM NEW.operation_kind THEN
      RAISE EXCEPTION 'operation_kind cannot change across quote versions' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER ledger_quotes_check_version BEFORE INSERT ON vynvori_ledger.ledger_quotes FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_quotes_check_version();

CREATE TRIGGER ledger_quotes_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_quotes FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_quotes_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_quotes FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

CREATE TABLE vynvori_ledger.ledger_quote_allocations(
  quote_version_id text NOT NULL REFERENCES vynvori_ledger.ledger_quotes(quote_version_id) ON DELETE RESTRICT,
  operation_index smallint NOT NULL CONSTRAINT ledger_quote_allocations_index_bounds CHECK (operation_index >= 0),
  hold_units bigint NOT NULL CONSTRAINT ledger_quote_allocations_hold_bounds CHECK (hold_units > 0 AND hold_units <= 9007199254740991),
  charge_units bigint NOT NULL CONSTRAINT ledger_quote_allocations_charge_bounds CHECK (charge_units > 0 AND charge_units <= hold_units),
  PRIMARY KEY (quote_version_id, operation_index)
);
CREATE TRIGGER ledger_quote_allocations_immutable BEFORE UPDATE OR DELETE ON vynvori_ledger.ledger_quote_allocations FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation();
CREATE TRIGGER ledger_quote_allocations_no_truncate BEFORE TRUNCATE ON vynvori_ledger.ledger_quote_allocations FOR EACH STATEMENT EXECUTE FUNCTION vynvori_ledger.reject_mutation();

-- DEFERRED: for the affected quote_version_id, a promo quote must have zero allocation rows; any other kind must have at
-- least one row, contiguous 0..N-1 operation_index (PK already enforces distinctness; max index = count-1 implies the exact
-- set {0..N-1}), SUM(hold_units) = max_charge_units and SUM(charge_units) = credits_quoted. Checked at COMMIT
-- (runLedgerCommand runs SET CONSTRAINTS ALL IMMEDIATE first), so a missing, extra or late allocation surfaces as a definite
-- error, never LEDGER_OUTCOME_UNKNOWN. Shared by both tables: each fires per row, re-verifying the same invariant from the
-- rows actually committed so far in this transaction.
CREATE FUNCTION vynvori_ledger.ledger_quote_check_allocation_sums() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  qv text := NEW.quote_version_id;
  kind text;
  max_hold bigint;
  credits bigint;
  n integer;
  hold_sum bigint;
  charge_sum bigint;
  max_index integer;
BEGIN
  IF TG_RELID NOT IN ('vynvori_ledger.ledger_quotes'::pg_catalog.regclass, 'vynvori_ledger.ledger_quote_allocations'::pg_catalog.regclass)
     OR TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'trigger function fired from an unexpected context' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT q.operation_kind, q.max_charge_units, q.credits_quoted INTO kind, max_hold, credits FROM vynvori_ledger.ledger_quotes q WHERE q.quote_version_id = qv;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation sum check fired for a quote_version_id with no quote row' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*), coalesce(sum(a.hold_units), 0), coalesce(sum(a.charge_units), 0), coalesce(max(a.operation_index), -1)
    INTO n, hold_sum, charge_sum, max_index FROM vynvori_ledger.ledger_quote_allocations a WHERE a.quote_version_id = qv;
  IF kind = 'promo_single_preview' THEN
    IF n <> 0 THEN
      RAISE EXCEPTION 'a promo quote must have no allocations' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF n = 0 THEN
      RAISE EXCEPTION 'allocations are required for a non-promo quote' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF max_index <> n - 1 THEN
      RAISE EXCEPTION 'allocation operation_index must be contiguous from 0' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF hold_sum <> max_hold OR charge_sum <> credits THEN
      RAISE EXCEPTION 'allocation sums must equal the quote totals' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER ledger_quotes_check_allocation_sums AFTER INSERT ON vynvori_ledger.ledger_quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_quote_check_allocation_sums();
CREATE CONSTRAINT TRIGGER ledger_quote_allocations_check_sums AFTER INSERT ON vynvori_ledger.ledger_quote_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_quote_check_allocation_sums();

REVOKE ALL ON FUNCTION vynvori_ledger.ledger_quotes_check_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION vynvori_ledger.ledger_quote_check_allocation_sums() FROM PUBLIC;
