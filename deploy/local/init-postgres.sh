#!/bin/sh
set -eu
# Only the official postgres image initialization runs this file, on a NEW volume.
# psql quoted variables escape password text as SQL literals, never SQL source.
psql --username "$POSTGRES_USER" --dbname postgres -X -v ON_ERROR_STOP=1 \
  --set=owner_password="$CQ_OWNER_PASSWORD" --set=app_password="$CQ_APP_PASSWORD" <<'SQL'
CREATE ROLE cityquest_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'owner_password';
CREATE ROLE cityquest_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD :'app_password';
CREATE DATABASE cityquest OWNER cityquest_owner;
REVOKE ALL ON DATABASE cityquest FROM PUBLIC;
GRANT CONNECT ON DATABASE cityquest TO cityquest_app;
SQL
