-- Run as cityquest_owner connected to database cityquest AFTER migrations.
-- Roles must already exist; never use the owner or a superuser for HTTP pods.
BEGIN;
REVOKE ALL ON DATABASE cityquest FROM PUBLIC;
GRANT CONNECT ON DATABASE cityquest TO cityquest_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM cityquest_app;
GRANT USAGE ON SCHEMA public TO cityquest_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cityquest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cityquest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cityquest_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations FROM cityquest_app;
REVOKE UPDATE, DELETE ON TABLE public.audit FROM cityquest_app;
-- Audit sequence numbers may be allocated, but historical audit rows cannot be rewritten by the app role.
-- No default CREATE/TRUNCATE privileges. Re-run this reviewed script after each schema migration.
COMMIT;
