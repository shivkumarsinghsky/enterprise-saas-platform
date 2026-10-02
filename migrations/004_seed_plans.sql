INSERT INTO plans (id, name) VALUES
  ('starter', 'Starter'),
  ('professional', 'Professional'),
  ('enterprise', 'Enterprise');

-- Features: assets (module), audit-log, custom-roles; limits: max-users, api-rate-limit (requests/minute).
INSERT INTO plan_features (plan_id, feature_key, limit_value) VALUES
  ('starter', 'assets', NULL),
  ('starter', 'max-users', 5),
  ('starter', 'api-rate-limit', 60),
  ('professional', 'assets', NULL),
  ('professional', 'audit-log', NULL),
  ('professional', 'custom-roles', NULL),
  ('professional', 'max-users', 50),
  ('professional', 'api-rate-limit', 600),
  ('enterprise', 'assets', NULL),
  ('enterprise', 'audit-log', NULL),
  ('enterprise', 'custom-roles', NULL),
  ('enterprise', 'max-users', NULL),
  ('enterprise', 'api-rate-limit', 3000);
