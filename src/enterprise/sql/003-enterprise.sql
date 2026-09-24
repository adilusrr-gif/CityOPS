-- Timestamps are Unix milliseconds, matching the v2 SQLite API and signed audit.
CREATE TABLE meta(key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE users(
 id text PRIMARY KEY,email text UNIQUE NOT NULL,name text NOT NULL,password text NOT NULL,
 role text NOT NULL CHECK(role IN ('player','business','admin')),xp integer NOT NULL DEFAULT 0,
 created_at bigint NOT NULL,mfa_enabled integer NOT NULL DEFAULT 0 CHECK(mfa_enabled IN(0,1)),
 mfa_secret text,mfa_pending_secret text,mfa_pending_at bigint,mfa_last_counter bigint NOT NULL DEFAULT -1,
 disabled integer NOT NULL DEFAULT 0 CHECK(disabled IN(0,1)),
 password_login_enabled integer NOT NULL DEFAULT 1 CHECK(password_login_enabled IN(0,1))
);
CREATE TABLE sessions(
 token text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires bigint NOT NULL,
 id text UNIQUE,created_at bigint NOT NULL DEFAULT 0,last_seen bigint NOT NULL DEFAULT 0,
 mfa_verified integer NOT NULL DEFAULT 0 CHECK(mfa_verified IN(0,1))
);
CREATE TABLE organizations(
 id text PRIMARY KEY,owner_id text REFERENCES users(id),name text NOT NULL,category text NOT NULL,
 lng double precision NOT NULL,lat double precision NOT NULL,address text NOT NULL DEFAULT '',description text NOT NULL DEFAULT '',
 status text NOT NULL CHECK(status IN('pending','approved','rejected')),source text NOT NULL DEFAULT 'manual',osm_id text UNIQUE,
 created_at bigint NOT NULL,city_id text NOT NULL DEFAULT 'almaty' CHECK(city_id IN('almaty','astana')),
 version integer NOT NULL DEFAULT 1,updated_at bigint NOT NULL DEFAULT 0
);
CREATE TABLE quests(
 id text PRIMARY KEY,owner_id text REFERENCES users(id),organization_id text REFERENCES organizations(id),
 title text NOT NULL,description text NOT NULL,lng double precision NOT NULL,lat double precision NOT NULL,radius integer NOT NULL,xp integer NOT NULL,
 scope text NOT NULL CHECK(scope IN('public','personal')),assigned_to text REFERENCES users(id),
 verification text NOT NULL CHECK(verification IN('checkin','code','token')),code_hash text,
 status text NOT NULL CHECK(status IN('draft','pending','published','archived')),goal integer NOT NULL DEFAULT 20,
 created_at bigint NOT NULL,city_id text NOT NULL DEFAULT 'almaty' CHECK(city_id IN('almaty','astana')),
 version integer NOT NULL DEFAULT 1,updated_at bigint NOT NULL DEFAULT 0,starts_at bigint,ends_at bigint,
 max_completions integer CHECK(max_completions IS NULL OR max_completions>0)
);
CREATE TABLE completions(user_id text NOT NULL REFERENCES users(id),quest_id text NOT NULL REFERENCES quests(id),xp integer NOT NULL,created_at bigint NOT NULL,PRIMARY KEY(user_id,quest_id));
CREATE TABLE explored(user_id text NOT NULL REFERENCES users(id),cell text NOT NULL,created_at bigint NOT NULL,city_id text NOT NULL DEFAULT 'almaty' CHECK(city_id IN('almaty','astana')),PRIMARY KEY(user_id,cell));
CREATE TABLE positions(user_id text PRIMARY KEY REFERENCES users(id),lng double precision NOT NULL,lat double precision NOT NULL,accuracy double precision NOT NULL,updated_at bigint NOT NULL,city_id text NOT NULL DEFAULT 'almaty' CHECK(city_id IN('almaty','astana')));
CREATE TABLE teams(id text PRIMARY KEY,name text NOT NULL,owner_id text NOT NULL REFERENCES users(id),invite text UNIQUE NOT NULL,created_at bigint NOT NULL,city_id text NOT NULL DEFAULT 'almaty' CHECK(city_id IN('almaty','astana')));
CREATE TABLE members(user_id text PRIMARY KEY REFERENCES users(id),team_id text NOT NULL REFERENCES teams(id),share_location integer NOT NULL DEFAULT 0 CHECK(share_location IN(0,1)),joined_at bigint NOT NULL);
-- IDs are explicitly allocated under a transaction advisory lock. Keeping them
-- contiguous also keeps imported v2 HMAC signatures byte-for-byte compatible.
CREATE TABLE audit(id bigint PRIMARY KEY,actor_id text REFERENCES users(id),action text NOT NULL,target text NOT NULL,created_at bigint NOT NULL,metadata text NOT NULL DEFAULT '{}',request_id text,prev_hash text,event_hash text);
CREATE TABLE recovery_codes(user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash text NOT NULL,used_at bigint,PRIMARY KEY(user_id,code_hash));
CREATE TABLE login_challenges(id_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires bigint NOT NULL,attempts integer NOT NULL DEFAULT 0);
CREATE TABLE reward_tokens(id text PRIMARY KEY,quest_id text NOT NULL REFERENCES quests(id),issuer_id text NOT NULL REFERENCES users(id),token_hash text UNIQUE NOT NULL,created_at bigint NOT NULL,expires_at bigint NOT NULL,redeemed_at bigint,redeemed_by text REFERENCES users(id),revoked_at bigint);
CREATE TABLE rate_limits(key text PRIMARY KEY,count integer NOT NULL,reset_at bigint NOT NULL);
CREATE TABLE oidc_states(state_hash text PRIMARY KEY,binding_hash text NOT NULL,nonce text NOT NULL,verifier_secret text NOT NULL,platform text NOT NULL CHECK(platform IN('web','mobile')),mobile_challenge text,expires bigint NOT NULL,created_at bigint NOT NULL);
CREATE TABLE oidc_identities(issuer text NOT NULL,subject text NOT NULL,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at bigint NOT NULL,PRIMARY KEY(issuer,subject));
CREATE TABLE mobile_auth_codes(code_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_challenge text NOT NULL,expires bigint NOT NULL,created_at bigint NOT NULL);
CREATE INDEX idx_session_user ON sessions(user_id);
CREATE INDEX session_expiry ON sessions(expires);
CREATE INDEX org_coords ON organizations(lat,lng);
CREATE INDEX org_city_status ON organizations(city_id,status,lat,lng);
CREATE INDEX quest_city_status ON quests(city_id,status,scope);
CREATE INDEX progress_city ON explored(user_id,city_id);
CREATE INDEX member_team ON members(team_id);
CREATE INDEX token_quest ON reward_tokens(quest_id,expires_at);
CREATE INDEX completion_quest ON completions(quest_id,created_at);
CREATE INDEX rate_expiry ON rate_limits(reset_at);
CREATE INDEX audit_action ON audit(action,created_at);
CREATE INDEX login_challenge_expiry ON login_challenges(expires);
CREATE INDEX oidc_state_expiry ON oidc_states(expires);
CREATE INDEX mobile_auth_expiry ON mobile_auth_codes(expires);
CREATE INDEX oidc_identity_user ON oidc_identities(user_id);
