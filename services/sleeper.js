import { jget } from '../utils/http.js';
import { createCache } from '../utils/cache.js';
import { config } from '../config/index.js';

const cache = createCache({ ttlSeconds: config.cacheTtlSeconds });
const base = 'https://api.sleeper.app/v1';

export const slp = {
  user: (username) => `${base}/user/${encodeURIComponent(username)}`,
  leagues: (userId, season) => `${base}/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`,
  league: (lid) => `${base}/league/${encodeURIComponent(lid)}`,
  users: (lid) => `${base}/league/${encodeURIComponent(lid)}/users`,
  rosters: (lid) => `${base}/league/${encodeURIComponent(lid)}/rosters`,
  drafts: (lid) => `${base}/league/${encodeURIComponent(lid)}/drafts`,
  draftPicks: (did) => `${base}/draft/${encodeURIComponent(did)}/picks`,
  players: () => `${base}/players/nfl`
};

export async function cget(url) {
  const hit = cache.get(url);
  if (hit) return hit;
  const data = await jget(url);
  cache.set(url, data);
  return data;
}
