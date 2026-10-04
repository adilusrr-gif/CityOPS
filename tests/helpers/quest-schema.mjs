// Reconstruct historical schemas for migration tests rather than merely changing
// their version marker while retaining columns that did not exist at the time.
export const REMOVE_QUEST_METADATA_SQL=`DROP INDEX IF EXISTS quest_difficulty_page;
 ALTER TABLE quests DROP COLUMN hint;
 ALTER TABLE quests DROP COLUMN objective_steps_json;
 ALTER TABLE quests DROP COLUMN estimated_minutes;
 ALTER TABLE quests DROP COLUMN difficulty_reason;
 ALTER TABLE quests DROP COLUMN difficulty;`;
