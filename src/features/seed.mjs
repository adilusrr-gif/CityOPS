import {seedAdventures} from './adventure-seed.mjs';
import {seedPhotoContests} from './photo-seed.mjs';

// Called only by local initialization or the explicit PostgreSQL --seed job.
// Individual seeds insert by stable ID and never overwrite operator edits.
export function* seedAdventureFeatures(now = Date.now()) {
 yield* seedAdventures(now);
 yield* seedPhotoContests(now);
}
