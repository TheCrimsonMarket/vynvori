-- M3 closure: asset access, malware-scan boundary and rate limits (ADR-0022 D3, D2 storage, D8 locks). Additive only:
-- creates new objects in vynvori_composition, alters no existing object except one new index on compositions, grants
-- nothing, seeds nothing. Reuses vynvori_composition.reject_mutation() from 0001. No scanner is named or chosen here;
-- this migration only stores scan facts that a future adapter reports (founder ruling QC).

-- ---------------------------------------------------------------------------------------------------------------
-- Per-subject advisory-lock helpers (ADR-0022 D8 / RR-2). Transaction-scoped locks only; hashtext output is never
-- persisted. The explicit unsigned mask stops a negative hashtext from sign-extending over the class-4 high word.
-- m3_lock_asset always takes the composition lock before the asset lock, so the acquisition order is enforced by
-- construction rather than by caller discipline.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION vynvori_composition.m3_lock_key_from_hash(h integer) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT (4::bigint << 32) | (h::bigint & 4294967295);
$fn$;

CREATE FUNCTION vynvori_composition.m3_lock_composition(composition_id uuid) RETURNS void
  LANGUAGE sql AS $fn$
  SELECT pg_advisory_xact_lock(vynvori_composition.m3_lock_key_from_hash(hashtext(composition_id::text)));
$fn$;

CREATE FUNCTION vynvori_composition.m3_lock_asset(composition_id uuid, asset_id uuid) RETURNS void
  LANGUAGE sql AS $fn$
  SELECT vynvori_composition.m3_lock_composition(composition_id);
  SELECT pg_advisory_xact_lock(vynvori_composition.m3_lock_key_from_hash(hashtext(asset_id::text)));
$fn$;

-- ---------------------------------------------------------------------------------------------------------------
-- Scan attempts (reservations; AGENTS rule 7, no uncontrolled billable retry). At most one open attempt per asset.
-- Nothing in SQL expires a lease automatically; closing an expired lease is an explicit application action.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE vynvori_composition.asset_scan_attempts (
  attempt_id uuid PRIMARY KEY,
  asset_id uuid NOT NULL,
  composition_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL CHECK (lease_expires_at > started_at),
  finished_at timestamptz NULL,
  outcome text NULL CHECK (outcome IN ('completed', 'lease_expired')),
  FOREIGN KEY (composition_id, asset_id) REFERENCES vynvori_composition.assets(composition_id, id) ON DELETE RESTRICT,
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
CREATE UNIQUE INDEX asset_scan_attempts_one_open ON vynvori_composition.asset_scan_attempts (asset_id) WHERE finished_at IS NULL;

CREATE FUNCTION vynvori_composition.check_scan_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.attempt_id <> NEW.attempt_id OR OLD.asset_id <> NEW.asset_id OR OLD.composition_id <> NEW.composition_id
     OR OLD.started_at <> NEW.started_at OR OLD.lease_expires_at <> NEW.lease_expires_at THEN
    RAISE EXCEPTION 'asset_scan_attempts: only finished_at/outcome may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'asset_scan_attempts: finished_at is one-way (already closed)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'asset_scan_attempts: finished_at may only move from NULL to non-null' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER asset_scan_attempts_update_guard BEFORE UPDATE ON vynvori_composition.asset_scan_attempts
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.check_scan_attempt_update();
CREATE TRIGGER asset_scan_attempts_no_delete BEFORE DELETE ON vynvori_composition.asset_scan_attempts
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER asset_scan_attempts_no_truncate BEFORE TRUNCATE ON vynvori_composition.asset_scan_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION vynvori_composition.reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Scan lifecycle (append-only). Current status of an asset = to_status of its highest seq; no event means pending.
-- Edges: pending -> clean | quarantined | unknown; unknown -> pending (explicit rescan request); clean -> quarantined
-- (late detection). quarantined is terminal and never auto-released; every other edge, including clean -> pending, is
-- rejected by the BEFORE INSERT trigger below.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE vynvori_composition.asset_scan_events (
  asset_id uuid NOT NULL,
  composition_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  from_status text NOT NULL CHECK (from_status IN ('pending', 'clean', 'quarantined', 'unknown')),
  to_status text NOT NULL CHECK (to_status IN ('pending', 'clean', 'quarantined', 'unknown')),
  asset_sha256 text NOT NULL CHECK (asset_sha256 ~ '^[a-f0-9]{64}$'),
  attempt_id uuid NULL REFERENCES vynvori_composition.asset_scan_attempts(attempt_id),
  scanner_id text NULL,
  engine_version text NULL,
  definitions_version text NULL,
  evidence_ref text NULL,
  reason_code text NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, seq),
  FOREIGN KEY (composition_id, asset_id) REFERENCES vynvori_composition.assets(composition_id, id) ON DELETE RESTRICT,
  CHECK (
    to_status NOT IN ('clean', 'quarantined')
    OR (
      scanner_id IS NOT NULL AND scanner_id <> ''
      AND engine_version IS NOT NULL AND engine_version <> ''
      AND definitions_version IS NOT NULL AND definitions_version <> ''
      AND evidence_ref IS NOT NULL AND evidence_ref <> ''
      AND attempt_id IS NOT NULL
    )
  ),
  CHECK (to_status NOT IN ('unknown', 'pending') OR (reason_code IS NOT NULL AND reason_code <> ''))
);

CREATE FUNCTION vynvori_composition.check_scan_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  current_status text;
  previous_seq integer;
  asset_hash text;
BEGIN
  -- Serializes every scan-event insert for this asset (and, by construction, for its composition) against
  -- concurrent writers before any read below, so "current status" is read under the lock that protects it.
  PERFORM vynvori_composition.m3_lock_asset(NEW.composition_id, NEW.asset_id);

  SELECT sha256 INTO asset_hash FROM vynvori_composition.assets WHERE composition_id = NEW.composition_id AND id = NEW.asset_id;
  IF asset_hash IS NULL THEN
    RAISE EXCEPTION 'asset_scan_events references an unknown asset' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF asset_hash <> NEW.asset_sha256 THEN
    RAISE EXCEPTION 'asset_scan_events.asset_sha256 does not match the asset row' USING ERRCODE = 'check_violation';
  END IF;

  SELECT to_status, seq INTO current_status, previous_seq FROM vynvori_composition.asset_scan_events
   WHERE asset_id = NEW.asset_id ORDER BY seq DESC LIMIT 1;
  IF current_status IS NULL THEN
    current_status := 'pending';
    previous_seq := 0;
  END IF;

  IF NEW.from_status <> current_status THEN
    RAISE EXCEPTION 'asset_scan_events.from_status (%) does not match the current status (%)', NEW.from_status, current_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.seq <> previous_seq + 1 THEN
    RAISE EXCEPTION 'asset_scan_events.seq must be gap-free (expected %, got %)', previous_seq + 1, NEW.seq USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    (NEW.from_status = 'pending' AND NEW.to_status IN ('clean', 'quarantined', 'unknown'))
    OR (NEW.from_status = 'unknown' AND NEW.to_status = 'pending')
    OR (NEW.from_status = 'clean' AND NEW.to_status = 'quarantined')
  ) THEN
    RAISE EXCEPTION 'asset_scan_events edge % -> % is not allowed', NEW.from_status, NEW.to_status USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$;
CREATE TRIGGER asset_scan_events_check_insert BEFORE INSERT ON vynvori_composition.asset_scan_events
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.check_scan_event();
CREATE TRIGGER asset_scan_events_immutable BEFORE UPDATE OR DELETE ON vynvori_composition.asset_scan_events
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER asset_scan_events_no_truncate BEFORE TRUNCATE ON vynvori_composition.asset_scan_events
  FOR EACH STATEMENT EXECUTE FUNCTION vynvori_composition.reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Short-lived, principal-bound download grants. Only the token hash is stored; the raw token is never persisted.
-- Single-use by default: redeemed_at may only move from NULL to a non-null value, and every other column is
-- immutable after insert.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE vynvori_composition.asset_download_grants (
  grant_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  asset_id uuid NOT NULL,
  composition_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('owner', 'guest')),
  principal_hash text NOT NULL CHECK (principal_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  redeemed_at timestamptz NULL,
  FOREIGN KEY (composition_id, asset_id) REFERENCES vynvori_composition.assets(composition_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION vynvori_composition.check_download_grant_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.grant_id <> NEW.grant_id OR OLD.token_hash <> NEW.token_hash OR OLD.asset_id <> NEW.asset_id
     OR OLD.composition_id <> NEW.composition_id OR OLD.principal_kind <> NEW.principal_kind
     OR OLD.principal_hash <> NEW.principal_hash OR OLD.issued_at <> NEW.issued_at OR OLD.expires_at <> NEW.expires_at THEN
    RAISE EXCEPTION 'asset_download_grants: only redeemed_at may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.redeemed_at IS NOT NULL THEN
    RAISE EXCEPTION 'asset_download_grants: redeemed_at is one-way (already redeemed)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.redeemed_at IS NULL THEN
    RAISE EXCEPTION 'asset_download_grants: redeemed_at may only move from NULL to non-null' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER asset_download_grants_update_guard BEFORE UPDATE ON vynvori_composition.asset_download_grants
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.check_download_grant_update();
CREATE TRIGGER asset_download_grants_no_delete BEFORE DELETE ON vynvori_composition.asset_download_grants
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER asset_download_grants_no_truncate BEFORE TRUNCATE ON vynvori_composition.asset_download_grants
  FOR EACH STATEMENT EXECUTE FUNCTION vynvori_composition.reject_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Rate-limit buckets. Mutable by design (the admission statement upserts): no immutability trigger here. The key
-- shape only; no limit, TTL or window value is stored or implied by this migration.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE vynvori_composition.rate_limit_buckets (
  bucket_key text NOT NULL CHECK (
    bucket_key ~ '^(GUEST_CREATE_GLOBAL|ASSET_UPLOAD_GLOBAL):global$'
    OR bucket_key ~ '^(GUEST_WRITE|GUEST_ASSET_UPLOAD|GUEST_DOWNLOAD_GRANT|GUEST_RESCAN|OWNER_WRITE|OWNER_ASSET_UPLOAD|OWNER_DOWNLOAD_GRANT|OWNER_RESCAN):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 1),
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX rate_limit_buckets_window ON vynvori_composition.rate_limit_buckets (window_start);

-- ---------------------------------------------------------------------------------------------------------------
-- Live-guest-draft counting (D2). The only change to an existing table in this migration: a new partial index,
-- no ALTER TABLE. Scoped to unowned guest drafts only.
-- ---------------------------------------------------------------------------------------------------------------
CREATE INDEX compositions_live_guest_drafts ON vynvori_composition.compositions (guest_draft_id)
  WHERE owner_user_id IS NULL AND guest_draft_id IS NOT NULL;
