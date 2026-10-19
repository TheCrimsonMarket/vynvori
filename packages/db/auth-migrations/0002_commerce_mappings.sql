-- Explicit additive proposal; no live migration runner is activated.
CREATE TABLE vynvori_identity.commerce_mappings (
  user_id uuid NOT NULL REFERENCES vynvori_identity.profiles(id),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  entity_id text NOT NULL CHECK (entity_id ~ '^vynvori:v1:[a-f0-9]{64}$'),
  operation_id uuid NOT NULL UNIQUE,
  request_cipher text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','dispatching','ready','reconcile_required','conflict')),
  auth_identity_id text,
  customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id),
  UNIQUE (project_id, entity_id),
  UNIQUE (project_id, auth_identity_id),
  UNIQUE (project_id, customer_id),
  CHECK ((state = 'ready' AND auth_identity_id IS NOT NULL AND customer_id IS NOT NULL)
      OR (state <> 'ready' AND auth_identity_id IS NULL AND customer_id IS NULL))
);
