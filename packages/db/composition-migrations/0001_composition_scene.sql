-- M3 composition scene persistence (ADR-0017). Additive only: creates one new schema, alters no existing object,
-- grants nothing, seeds nothing. References vynvori_identity (M1b) one-way; nothing references this schema.
CREATE SCHEMA vynvori_composition;

-- Preview-only print profile registry. M3 cannot store an approved/print-eligible profile: the CHECKs below are the
-- database-level half of "nothing reaches an unapproved print state". M5 relaxes them in its own reviewed migration.
CREATE TABLE vynvori_composition.print_profiles (
  profile_id text NOT NULL CHECK (profile_id <> ''),
  version text NOT NULL CHECK (version <> ''),
  status text NOT NULL CHECK (status IN ('synthetic_unapproved', 'draft_unapproved')),
  supplier_approved boolean NOT NULL DEFAULT false CHECK (supplier_approved = false),
  print_release_eligible boolean NOT NULL DEFAULT false CHECK (print_release_eligible = false),
  definition jsonb NOT NULL,
  definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, version)
);

-- Mutable working draft. Ownership: a verified-SSO owner (owner_user_id) or an unclaimed, unexpired guest capability
-- (guest_draft_id -> vynvori_identity.guest_drafts, whose expiry and claim state are authoritative).
CREATE TABLE vynvori_composition.compositions (
  id uuid PRIMARY KEY,
  owner_user_id uuid REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT,
  guest_draft_id uuid UNIQUE REFERENCES vynvori_identity.guest_drafts(id) ON DELETE RESTRICT,
  product_family text NOT NULL CHECK (product_family <> ''),
  print_profile_id text NOT NULL,
  print_profile_version text NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('guest_draft', 'editable_scene', 'saved_owned', 'frozen_version')),
  draft_scene jsonb NOT NULL,
  draft_scene_sha256 text NOT NULL CHECK (draft_scene_sha256 ~ '^[a-f0-9]{64}$'),
  draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (print_profile_id, print_profile_version) REFERENCES vynvori_composition.print_profiles(profile_id, version) ON DELETE RESTRICT,
  CHECK (owner_user_id IS NOT NULL OR guest_draft_id IS NOT NULL),
  CHECK (lifecycle_state <> 'saved_owned' OR owner_user_id IS NOT NULL),
  CHECK (lifecycle_state <> 'guest_draft' OR (owner_user_id IS NULL AND guest_draft_id IS NOT NULL)),
  CHECK (lifecycle_state <> 'frozen_version' OR current_version_id IS NOT NULL)
);
CREATE INDEX compositions_owner ON vynvori_composition.compositions (owner_user_id, updated_at DESC) WHERE owner_user_id IS NOT NULL;

-- Private customer originals. Row = immutable fact about one stored object; bytes live in private R2 (never public).
CREATE TABLE vynvori_composition.assets (
  id uuid PRIMARY KEY,
  composition_id uuid NOT NULL REFERENCES vynvori_composition.compositions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind = 'customer_original'),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^private/composition/v1/[0-9a-f-]{36}/[a-f0-9]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  width_px integer NOT NULL CHECK (width_px > 0 AND width_px <= 20000),
  height_px integer NOT NULL CHECK (height_px > 0 AND height_px <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (composition_id, sha256),
  UNIQUE (composition_id, id)
);

-- Immutable frozen snapshots (Plane D frozen_version). Editing never touches a row here; it creates the next version.
CREATE TABLE vynvori_composition.composition_versions (
  id uuid PRIMARY KEY,
  composition_id uuid NOT NULL REFERENCES vynvori_composition.compositions(id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no >= 1),
  scene jsonb NOT NULL,
  scene_sha256 text NOT NULL CHECK (scene_sha256 ~ '^[a-f0-9]{64}$'),
  source_asset_sha256 text[] NOT NULL,
  source_font_sha256 text[] NOT NULL,
  print_profile_id text NOT NULL,
  print_profile_version text NOT NULL,
  preflight_state text NOT NULL CHECK (preflight_state IN ('preview_only', 'blocked')),
  preflight_issues jsonb NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (composition_id, version_no),
  UNIQUE (composition_id, scene_sha256),
  UNIQUE (composition_id, id),
  FOREIGN KEY (print_profile_id, print_profile_version) REFERENCES vynvori_composition.print_profiles(profile_id, version) ON DELETE RESTRICT
);
ALTER TABLE vynvori_composition.compositions
  ADD CONSTRAINT compositions_current_version FOREIGN KEY (id, current_version_id)
  REFERENCES vynvori_composition.composition_versions(composition_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION vynvori_composition.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'vynvori_composition.% is immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;
CREATE TRIGGER composition_versions_immutable BEFORE UPDATE OR DELETE ON vynvori_composition.composition_versions
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER assets_immutable BEFORE UPDATE OR DELETE ON vynvori_composition.assets
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER print_profiles_immutable BEFORE UPDATE OR DELETE ON vynvori_composition.print_profiles
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER composition_versions_no_truncate BEFORE TRUNCATE ON vynvori_composition.composition_versions
  FOR EACH STATEMENT EXECUTE FUNCTION vynvori_composition.reject_mutation();
CREATE TRIGGER assets_no_truncate BEFORE TRUNCATE ON vynvori_composition.assets
  FOR EACH STATEMENT EXECUTE FUNCTION vynvori_composition.reject_mutation();

-- Defence in depth: a version may only pin image hashes that exist as stored assets of the SAME composition.
CREATE FUNCTION vynvori_composition.require_pinned_assets() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE missing text;
BEGIN
  SELECT h INTO missing FROM unnest(NEW.source_asset_sha256) AS h
   WHERE NOT EXISTS (SELECT 1 FROM vynvori_composition.assets a WHERE a.composition_id = NEW.composition_id AND a.sha256 = h) LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'composition version pins an unknown asset hash' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER composition_versions_pinned_assets BEFORE INSERT ON vynvori_composition.composition_versions
  FOR EACH ROW EXECUTE FUNCTION vynvori_composition.require_pinned_assets();
