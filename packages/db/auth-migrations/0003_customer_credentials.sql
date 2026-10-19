-- Explicit additive proposal. Credentials are ciphertext; cache never authorizes a request.
ALTER TABLE vynvori_identity.sessions
  ADD COLUMN commerce_cipher text,
  ADD COLUMN commerce_project_id text,
  ADD COLUMN commerce_auth_identity_id text,
  ADD COLUMN commerce_customer_id text,
  ADD COLUMN commerce_expires_at timestamptz;
ALTER TABLE vynvori_identity.sessions ADD CONSTRAINT commerce_credential_complete CHECK (
  (commerce_cipher IS NULL AND commerce_project_id IS NULL AND commerce_auth_identity_id IS NULL AND commerce_customer_id IS NULL AND commerce_expires_at IS NULL)
  OR (commerce_cipher IS NOT NULL AND commerce_project_id IS NOT NULL AND commerce_auth_identity_id IS NOT NULL AND commerce_customer_id IS NOT NULL AND commerce_expires_at IS NOT NULL AND commerce_expires_at <= expires_at)
);
