-- Tenant isolation enforced by PostgreSQL. The application sets the tenant for each transaction with
--   SET LOCAL app.tenant_id = '<uuid>'
-- and every tenant-scoped table only exposes rows of that tenant. If the setting is missing,
-- current_setting(..., true) returns NULL and no rows match: the safe default is "see nothing".
-- FORCE makes the policies apply even to the table owner.

CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'roles', 'user_roles', 'assets', 'audit_events', 'outbox', 'notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
  END LOOP;
END $$;
