-- The description a bank, broker or import file sent with an activity, kept
-- as received. `notes` stays the user's own text: editing it no longer changes
-- what categorization rules match, and the original description is not lost.
ALTER TABLE activities ADD COLUMN imported_description TEXT;

-- Activities already imported have only `notes`, which holds the description
-- they arrived with unless the user has edited it since; an edited original
-- cannot be recovered. An activity was imported when
--   * a file or add-on import created it: every such row is stored with
--     source_system 'CSV'; or
--   * a broker or bank sync created it: a source other than MANUAL with an
--     import run or a provider record id, the rule `Activity::is_broker_synced`
--     applies.
-- Manual entries, and rows from before sources were recorded (NULL source and
-- no import run or record id), keep NULL: their notes are the user's own. So
-- does an imported row the user has edited, whose notes may no longer be the
-- bank's text; rules keep matching its notes.
UPDATE activities
SET imported_description = notes
WHERE notes IS NOT NULL
  AND TRIM(notes) <> ''
  AND is_user_modified = 0
  AND (
    UPPER(TRIM(COALESCE(source_system, ''))) = 'CSV'
    OR (
      UPPER(TRIM(COALESCE(source_system, ''))) <> 'MANUAL'
      AND (
        TRIM(COALESCE(import_run_id, '')) <> ''
        OR TRIM(COALESCE(source_record_id, '')) <> ''
      )
    )
  );
