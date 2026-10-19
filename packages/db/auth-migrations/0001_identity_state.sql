-- Explicit M1b migration proposal. Not part of the M2 automatic migration journal.
-- No existing table, index, role or grant is altered.
CREATE SCHEMA vynvori_identity;

CREATE TABLE vynvori_identity.profiles (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE TABLE vynvori_identity.login_transactions (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  verifier_cipher text NOT NULL,
  callback text NOT NULL,
  return_path text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE TABLE vynvori_identity.sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES vynvori_identity.profiles(id),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation <= 96),
  status text NOT NULL CHECK (status IN ('active', 'refreshing', 'reauth_required', 'revoked')),
  central_revoke_state text NOT NULL DEFAULT 'none' CHECK (central_revoke_state IN ('none', 'pending', 'confirmed')),
  credentials_cipher text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  refresh_lease_id uuid,
  refresh_deadline timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
  CHECK (idle_expires_at <= expires_at),
  CHECK ((status = 'refreshing' AND refresh_lease_id IS NOT NULL AND refresh_deadline IS NOT NULL)
      OR (status <> 'refreshing' AND refresh_lease_id IS NULL AND refresh_deadline IS NULL))
);
CREATE TABLE vynvori_identity.guest_drafts (
  id uuid PRIMARY KEY,
  capability_hash text NOT NULL UNIQUE CHECK (capability_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid REFERENCES vynvori_identity.profiles(id),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz
);
