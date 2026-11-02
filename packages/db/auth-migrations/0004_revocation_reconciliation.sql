-- Additive proposal only; never invoked at application startup.
-- Historical sessions without a cohort are retained for explicit operator review.
ALTER TABLE vynvori_identity.sessions
  ADD COLUMN authority_client_id text,
  ADD COLUMN deployment text,
  ADD COLUMN revoke_attempts integer NOT NULL DEFAULT 0 CHECK (revoke_attempts BETWEEN 0 AND 8),
  ADD COLUMN revoke_next_at timestamptz,
  ADD COLUMN revoke_lease_id uuid,
  ADD COLUMN revoke_lease_until timestamptz;
ALTER TABLE vynvori_identity.sessions ADD CONSTRAINT revoke_lease_complete CHECK (
  (revoke_lease_id IS NULL AND revoke_lease_until IS NULL)
  OR (revoke_lease_id IS NOT NULL AND revoke_lease_until IS NOT NULL AND status='revoked' AND central_revoke_state='pending')
);
CREATE INDEX sessions_pending_revoke ON vynvori_identity.sessions (deployment,authority_client_id,revoke_next_at)
  WHERE central_revoke_state <> 'confirmed' AND revoke_attempts < 8;
