-- Additive read-model indexes. Keep released 003/004/005 migrations immutable.
-- Prefixes match authorization/city predicates; tie-breakers make cursor pages
-- stable when imported organizations and quests share a creation timestamp.
CREATE INDEX IF NOT EXISTS org_catalog_page ON organizations(city_id,status,name,id);
CREATE INDEX IF NOT EXISTS org_manage_page ON organizations(city_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS org_owner_page ON organizations(owner_id,city_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS quest_public_page ON quests(city_id,status,scope DESC,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS quest_manage_page ON quests(city_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS quest_owner_page ON quests(owner_id,city_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS user_manage_page ON users(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS explored_page ON explored(user_id,city_id,cell);
CREATE INDEX IF NOT EXISTS completion_user_page ON completions(user_id,created_at DESC,quest_id DESC);
CREATE INDEX IF NOT EXISTS token_history_page ON reward_tokens(quest_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS photo_owner_status ON photos(user_id,status);
