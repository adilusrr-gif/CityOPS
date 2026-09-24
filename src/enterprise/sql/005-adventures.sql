-- Portable additive DDL: SQLite schema 4 and PostgreSQL schema 5.
-- Editorial seed data is installed by the explicit seed workflow, never here.
-- Timestamps are UTC milliseconds; only rounded photograph locations are stored.
CREATE TABLE adventure_routes(
 id text PRIMARY KEY,city_id text NOT NULL CHECK(city_id IN('almaty','astana')),
 title text NOT NULL,description text NOT NULL,kind text NOT NULL CHECK(kind IN('urban','mountain')),
 difficulty text NOT NULL CHECK(difficulty IN('easy','moderate','hard')),cautions text NOT NULL DEFAULT '',source_urls text NOT NULL DEFAULT '[]',checkpoints_json text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','open','closed')),status_reason text NOT NULL DEFAULT '',
 verified_by text REFERENCES users(id) ON DELETE SET NULL,verified_at bigint,created_at bigint NOT NULL,updated_at bigint NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),xp integer NOT NULL CHECK(xp BETWEEN 0 AND 500)
);
CREATE TABLE adventure_checkins(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,route_id text NOT NULL REFERENCES adventure_routes(id),
 route_version integer NOT NULL CHECK(route_version>0),checkpoint_index integer NOT NULL CHECK(checkpoint_index>=0),
 altitude_m integer,created_at bigint NOT NULL,
 PRIMARY KEY(user_id,route_id,route_version,checkpoint_index)
);
CREATE TABLE adventure_rewards(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,route_id text NOT NULL REFERENCES adventure_routes(id),
 xp integer NOT NULL CHECK(xp BETWEEN 0 AND 500),created_at bigint NOT NULL,PRIMARY KEY(user_id,route_id)
);
CREATE TABLE territory_zones(
 id text PRIMARY KEY,city_id text NOT NULL CHECK(city_id IN('almaty','astana')),title text NOT NULL,description text NOT NULL,
 lng double precision NOT NULL CHECK(lng BETWEEN -180 AND 180),lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90),
 radius integer NOT NULL CHECK(radius>0),status text NOT NULL CHECK(status IN('active','disabled')),
 created_at bigint NOT NULL,updated_at bigint NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE territory_visits(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,zone_id text NOT NULL REFERENCES territory_zones(id),
 season text NOT NULL,day integer NOT NULL,team_id text REFERENCES teams(id) ON DELETE SET NULL,created_at bigint NOT NULL,
 PRIMARY KEY(user_id,zone_id,day)
);
CREATE TABLE photo_contests(
 id text PRIMARY KEY,city_id text NOT NULL CHECK(city_id IN('almaty','astana')),title text NOT NULL,description text NOT NULL,
 status text NOT NULL CHECK(status IN('draft','published')),starts_at bigint NOT NULL,submissions_close_at bigint NOT NULL,
 votes_close_at bigint NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by text REFERENCES users(id),
 created_at bigint NOT NULL,updated_at bigint NOT NULL,
 CHECK(starts_at<submissions_close_at AND submissions_close_at<votes_close_at)
);
CREATE TABLE photos(
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 city_id text NOT NULL CHECK(city_id IN('almaty','astana')),contest_id text REFERENCES photo_contests(id),
 title text NOT NULL,caption text NOT NULL DEFAULT '',cell text NOT NULL,
 approx_lng double precision NOT NULL CHECK(approx_lng BETWEEN -180 AND 180),approx_lat double precision NOT NULL CHECK(approx_lat BETWEEN -90 AND 90),
 status text NOT NULL CHECK(status IN('pending','approved','rejected','withdrawn')),
 image_base64 text,image_bytes integer NOT NULL CHECK(image_bytes>=0),image_sha256 text NOT NULL,
 width integer NOT NULL CHECK(width>0),height integer NOT NULL CHECK(height>0),
 created_at bigint NOT NULL,updated_at bigint NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 reviewed_by text REFERENCES users(id),review_reason text NOT NULL DEFAULT '',UNIQUE(contest_id,id)
);
CREATE TABLE photo_storage(
 id integer PRIMARY KEY CHECK(id=1),used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0)
);
CREATE TABLE photo_upload_usage(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,day integer NOT NULL,
 count integer NOT NULL DEFAULT 0 CHECK(count>=0),PRIMARY KEY(user_id,day)
);
-- Intentionally retain discovery deduplication when a photograph is withdrawn.
CREATE TABLE photo_discovery_rewards(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,city_id text NOT NULL CHECK(city_id IN('almaty','astana')),
 cell text NOT NULL,photo_id text NOT NULL,xp integer NOT NULL CHECK(xp>=0),created_at bigint NOT NULL,
 PRIMARY KEY(user_id,city_id,cell)
);
CREATE TABLE photo_votes(
 contest_id text NOT NULL REFERENCES photo_contests(id),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 photo_id text NOT NULL,created_at bigint NOT NULL,updated_at bigint NOT NULL,PRIMARY KEY(contest_id,user_id),
 FOREIGN KEY(contest_id,photo_id) REFERENCES photos(contest_id,id)
);
CREATE TABLE photo_reports(
 id text PRIMARY KEY,photo_id text NOT NULL REFERENCES photos(id),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason text NOT NULL,status text NOT NULL CHECK(status IN('open','resolved')),created_at bigint NOT NULL,
 reviewed_by text REFERENCES users(id),reviewed_at bigint,UNIQUE(photo_id,user_id)
);
CREATE INDEX adventure_route_city_status ON adventure_routes(city_id,status);
CREATE INDEX adventure_checkin_progress ON adventure_checkins(user_id,route_id,route_version);
CREATE INDEX adventure_reward_user_time ON adventure_rewards(user_id,created_at);
CREATE INDEX adventure_reward_route ON adventure_rewards(route_id);
CREATE INDEX territory_zone_city_status ON territory_zones(city_id,status);
CREATE INDEX territory_season_zone_team ON territory_visits(season,zone_id,team_id);
CREATE INDEX territory_visit_user_day ON territory_visits(user_id,day);
-- Last-member team deletion preserves daily deduplication with SET NULL.
-- A team-leading index prevents that FK action from scanning all past visits.
CREATE INDEX territory_visit_team ON territory_visits(team_id);
CREATE INDEX photo_contest_city_status ON photo_contests(city_id,status,starts_at);
CREATE INDEX photo_city_status_time ON photos(city_id,status,created_at,id);
CREATE INDEX photo_owner_time ON photos(user_id,created_at,id);
CREATE INDEX photo_owner_image_hash ON photos(user_id,image_sha256);
CREATE INDEX photo_contest_status ON photos(contest_id,status,created_at,id);
CREATE INDEX photo_vote_photo ON photo_votes(photo_id);
CREATE INDEX photo_usage_expiry ON photo_upload_usage(day,user_id);
CREATE INDEX photo_reports_status ON photo_reports(status,created_at);
