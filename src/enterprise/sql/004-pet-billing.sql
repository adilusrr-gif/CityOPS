-- Portable additive DDL: SQLite schema 3 and PostgreSQL schema 4 share this file.
-- Millisecond timestamps and integer KZT prices avoid timezone/rounding drift.
CREATE TABLE pets(
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL,species text NOT NULL CHECK(species IN('fox','cat','dragon')),color text NOT NULL,
 xp integer NOT NULL DEFAULT 0 CHECK(xp>=0),created_at bigint NOT NULL,updated_at bigint NOT NULL,
 consent_at bigint,adult_attested_at bigint,chat_epoch integer NOT NULL DEFAULT 0 CHECK(chat_epoch>=0)
);
CREATE TABLE pet_rewards(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_key text NOT NULL,
 xp integer NOT NULL CHECK(xp>=0),created_at bigint NOT NULL,PRIMARY KEY(user_id,event_key)
);
CREATE TABLE pet_chat_requests(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id text NOT NULL,request_hash text NOT NULL,
 status text NOT NULL CHECK(status IN('reserved','complete','failed')),epoch integer NOT NULL CHECK(epoch>=0),
 mode text NOT NULL CHECK(mode IN('ai','offline','support')),reply_cipher text,created_at bigint NOT NULL,expires_at bigint NOT NULL,
 PRIMARY KEY(user_id,request_id)
);
CREATE TABLE pet_messages(
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id text NOT NULL,
 role text NOT NULL CHECK(role IN('user','assistant')),mode text NOT NULL CHECK(mode IN('ai','offline','support')),
 content_cipher text NOT NULL,created_at bigint NOT NULL,expires_at bigint NOT NULL
);
-- '*' is the aggregate provider budget; no account FK applies to this row.
CREATE TABLE pet_usage(
 day integer NOT NULL,user_id text NOT NULL,count integer NOT NULL DEFAULT 0 CHECK(count>=0),PRIMARY KEY(day,user_id)
);
CREATE TABLE billing_orders(
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),
 plan text NOT NULL CHECK(plan IN('plus','business_start','business_pro')),
 amount integer NOT NULL CHECK(amount>0),currency text NOT NULL DEFAULT 'KZT' CHECK(currency='KZT'),
 status text NOT NULL CHECK(status IN('pending','paid','refunded','expired')),idempotency_key text NOT NULL,
 created_at bigint NOT NULL,expires_at bigint NOT NULL,paid_at bigint,refunded_at bigint,
 payment_reference text UNIQUE,service_starts_at bigint,service_ends_at bigint,admin_note text,
 UNIQUE(user_id,idempotency_key)
);
CREATE TABLE billing_entitlements(
 id text PRIMARY KEY,order_id text UNIQUE NOT NULL REFERENCES billing_orders(id),user_id text NOT NULL REFERENCES users(id),
 plan text NOT NULL CHECK(plan IN('plus','business_start','business_pro')),
 starts_at bigint NOT NULL,ends_at bigint NOT NULL CHECK(ends_at>starts_at),revoked_at bigint
);
CREATE TABLE promotions(
 id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),organization_id text NOT NULL REFERENCES organizations(id),
 quest_id text REFERENCES quests(id),city_id text NOT NULL CHECK(city_id IN('almaty','astana')),
 title text NOT NULL,description text NOT NULL,status text NOT NULL CHECK(status IN('pending','approved','rejected','archived')),
 created_at bigint NOT NULL,updated_at bigint NOT NULL,reviewed_at bigint,reviewed_by text REFERENCES users(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE INDEX pet_rewards_created ON pet_rewards(user_id,created_at);
CREATE INDEX pet_request_expiry ON pet_chat_requests(expires_at);
CREATE INDEX pet_request_active ON pet_chat_requests(user_id,status,created_at);
CREATE INDEX pet_message_history ON pet_messages(user_id,created_at,id);
CREATE INDEX pet_message_expiry ON pet_messages(expires_at);
CREATE INDEX billing_user_orders ON billing_orders(user_id,created_at);
CREATE INDEX billing_order_status ON billing_orders(status,created_at);
CREATE INDEX billing_user_entitlements ON billing_entitlements(user_id,ends_at);
CREATE INDEX promotion_city_status ON promotions(city_id,status);
CREATE INDEX promotion_owner_status ON promotions(owner_id,status);
