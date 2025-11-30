-- scripts/20251201_party_handle_alignment.sql
-- Align tt_party_member and tt_photo with handle-based identity.

BEGIN;

-- 1) Ensure handle-based columns exist on tt_party_member.
ALTER TABLE tt_party_member
  ADD COLUMN IF NOT EXISTS handle text,
  ADD COLUMN IF NOT EXISTS invited_by_handle text;

-- 2) Backfill from legacy member ids when possible.
UPDATE tt_party_member pm
SET handle            = m.handle,
    invited_by_handle = COALESCE(m2.handle, invited_by_handle)
FROM ff_member m
LEFT JOIN ff_member m2 ON m2.member_id = pm.invited_by
WHERE m.member_id = pm.member_id
  AND pm.handle IS NULL;

-- 3) Enforce handle presence and create PK on (party_id, handle).
ALTER TABLE tt_party_member
  ALTER COLUMN handle SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'tt_party_member'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'tt_party_member_pkey'
  ) THEN
    ALTER TABLE tt_party_member DROP CONSTRAINT tt_party_member_pkey;
  END IF;
END$$;

ALTER TABLE tt_party_member
  ADD CONSTRAINT tt_party_member_pkey PRIMARY KEY (party_id, handle);

CREATE INDEX IF NOT EXISTS tt_party_member_handle_idx
  ON tt_party_member(handle);

-- 4) Ensure tt_photo has handle column populated.
ALTER TABLE tt_photo
  ADD COLUMN IF NOT EXISTS handle text;

UPDATE tt_photo t
SET handle = m.handle
FROM ff_member m
WHERE m.member_id = t.member_id
  AND t.handle IS NULL;

ALTER TABLE tt_photo
  ALTER COLUMN handle SET NOT NULL;

CREATE INDEX IF NOT EXISTS tt_photo_handle_idx
  ON tt_photo(handle);

COMMIT;
