// Persisted cells and levels are versioned product semantics. Changing these
// constants requires a data migration; they deliberately have no env override.
export const EXPLORATION_GRID = Object.freeze({lngCellSize: .002, latCellSize: .0015});
export const PROGRESSION = Object.freeze({xpPerLevel: 500});

// Canonical photo constraints also protect imported backups and mobile clients.
// Operational limits can be reduced by limiting upload/storage quotas; increasing
// media dimensions or decoder parallelism requires a measured release change.
export const PHOTO_MEDIA_LIMITS = Object.freeze({inputBytes: 3 * 1024 * 1024, outputBytes: 512 * 1024, maxPixels: 12_000_000, maxSide: 1280, decoderConcurrency: 2, decoderQueue: 4});

function setting(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(String(raw)) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

// Read once at startup. Invalid operator settings fail closed instead of silently
// falling back or allowing different rules in the UI and API.
export function loadProductPolicy(env = process.env) {
  return Object.freeze({
    gps: Object.freeze({maxAgeMs: setting(env, 'GAME_GPS_MAX_AGE_SECONDS', 90, 30, 120) * 1000, maxAccuracyM: setting(env, 'GAME_GPS_MAX_ACCURACY_METERS', 80, 10, 100)}),
    territories: Object.freeze({dailyVisits: setting(env, 'TERRITORY_DAILY_VISIT_LIMIT', 10, 1, 50)}),
    adventures: Object.freeze({petXp: setting(env, 'ADVENTURE_PET_XP', 20, 0, 100)}),
    photos: Object.freeze({
      discoveryXp: setting(env, 'PHOTO_DISCOVERY_XP', 20, 0, 100),
      petXp: setting(env, 'PHOTO_PET_XP', 10, 0, 100),
      dailyUploads: setting(env, 'PHOTO_DAILY_UPLOAD_LIMIT', 5, 1, 20),
      retained: setting(env, 'PHOTO_RETAINED_LIMIT', 20, 1, 100),
      voterMinAgeMs: setting(env, 'PHOTO_VOTER_MIN_AGE_HOURS', 24, 24, 720) * 3600000,
      inputBytes: PHOTO_MEDIA_LIMITS.inputBytes,
      outputBytes: PHOTO_MEDIA_LIMITS.outputBytes,
      maxPixels: PHOTO_MEDIA_LIMITS.maxPixels,
    }),
    photoStorageBytes: setting(env, 'PHOTO_STORAGE_LIMIT_MB', 100, 1, 10240) * 1024 * 1024,
    exploration: EXPLORATION_GRID,
    progression: PROGRESSION,
  });
}

// Explicit projection: operational capacity, provider keys and environment data
// must never become public merely because a new internal setting is added.
export function publicProductPolicy(policy) {
  const {gps, territories, adventures, photos, exploration, progression} = policy;
  return {
    gps: {maxAgeMs: gps.maxAgeMs, maxAccuracyM: gps.maxAccuracyM},
    territories: {dailyVisits: territories.dailyVisits},
    adventures: {petXp: adventures.petXp},
    photos: {discoveryXp: photos.discoveryXp, petXp: photos.petXp, dailyUploads: photos.dailyUploads, retained: photos.retained, voterMinAgeMs: photos.voterMinAgeMs, inputBytes: photos.inputBytes, outputBytes: photos.outputBytes, maxPixels: photos.maxPixels},
    exploration: {lngCellSize: exploration.lngCellSize, latCellSize: exploration.latCellSize},
    progression: {xpPerLevel: progression.xpPerLevel},
  };
}
