-- Platform-level tables (not tenant-scoped) -------------------------------------------------------------

CREATE TABLE plans (
  id   text PRIMARY KEY,
  name text NOT NULL
);

-- A plan grants features (modules). limit_value is feature-specific (max users, requests per minute).
CREATE TABLE plan_features (
  plan_id     text NOT NULL REFERENCES plans (id),
  feature_key text NOT NULL,
  limit_value integer,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'PROVISIONING' CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED')),
  region     text NOT NULL,
  plan_id    text NOT NULL REFERENCES plans (id),
  -- Which database cluster holds this tenant's data: 'pooled' or the key of a dedicated cluster.
  placement  text NOT NULL DEFAULT 'pooled',
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_feature_overrides (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  feature_key text NOT NULL,
  enabled     boolean NOT NULL,
  limit_value integer,
  PRIMARY KEY (tenant_id, feature_key)
);

-- Tenant-scoped tables: every row carries tenant_id and is protected by row-level security (002) -------

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  permissions text[] NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, name)
);

CREATE TABLE user_roles (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id   uuid NOT NULL REFERENCES users (id),
  role_id   uuid NOT NULL REFERENCES roles (id),
  PRIMARY KEY (user_id, role_id)
);

-- Example business module: an asset register (as in Enterprise Asset Management).
CREATE TABLE assets (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  tag        text NOT NULL,
  name       text NOT NULL,
  location   text,
  status     text NOT NULL DEFAULT 'IN_SERVICE' CHECK (status IN ('IN_SERVICE', 'OUT_OF_SERVICE', 'RETIRED')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tag)
);

CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  actor_id       text NOT NULL,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time ON audit_events (tenant_id, occurred_at DESC);

-- Domain events for asynchronous work (notifications, integrations). Written in the same transaction.
CREATE TABLE outbox (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  correlation_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox (created_at) WHERE processed_at IS NULL;

-- Records of notifications produced by the dispatcher (stand-in for an email/SMS provider).
CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  recipient  text NOT NULL,
  template   text NOT NULL,
  source_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
