-- Additive editorial metadata only. Existing IDs, revisions, rewards and
-- completion records are unchanged; unknown legacy estimates remain unknown.
ALTER TABLE quests ADD COLUMN difficulty text CHECK(difficulty IS NULL OR difficulty IN('easy','moderate','hard'));
ALTER TABLE quests ADD COLUMN difficulty_reason text NOT NULL DEFAULT '' CHECK(length(difficulty_reason)<=500);
ALTER TABLE quests ADD COLUMN estimated_minutes integer CHECK(estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 240);
ALTER TABLE quests ADD COLUMN objective_steps_json text NOT NULL DEFAULT '[]' CHECK(length(objective_steps_json)<=10000);
ALTER TABLE quests ADD COLUMN hint text NOT NULL DEFAULT '' CHECK(length(hint)<=500);
CREATE INDEX quest_difficulty_page ON quests(city_id,status,difficulty,scope DESC,created_at DESC,id DESC);
