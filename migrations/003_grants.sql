-- The application connects as saas_app (created by scripts/migrate.ts), which is NOT the table owner and has no
-- BYPASSRLS, so row-level security always applies to it. Migrations run as the owner role.

GRANT USAGE ON SCHEMA public TO saas_app;

GRANT SELECT ON plans, plan_features TO saas_app;
GRANT SELECT, INSERT, UPDATE ON tenants TO saas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_feature_overrides TO saas_app;
GRANT SELECT, INSERT, UPDATE ON users, roles, assets TO saas_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO saas_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO saas_app;
GRANT SELECT, INSERT ON notifications TO saas_app;

-- Audit log is append-only for the application: no UPDATE or DELETE.
GRANT SELECT, INSERT ON audit_events TO saas_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO saas_app;
