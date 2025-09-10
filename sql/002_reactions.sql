-- Types/tables from earlier assumed created.
-- Add the high-value indexes for write/read paths.

-- lookups for "is own team?"
CREATE INDEX IF NOT EXISTS idx_fut_user_team_key
  ON fein_user_teams (user_id, season, league_id, team_id);

-- reaction totals hot path
CREATE INDEX IF NOT EXISTS idx_frt_entity
  ON fein_reaction_totals (entity_key, type);

-- per-user bucket toggles (fish/trash) and fire stacks
CREATE INDEX IF NOT EXISTS idx_fru_entity_user
  ON fein_reaction_user (entity_key, user_id, type);

-- OPTIONAL: narrow totals fetch by just entity_key
CREATE INDEX IF NOT EXISTS idx_frt_entity_only
  ON fein_reaction_totals (entity_key);
