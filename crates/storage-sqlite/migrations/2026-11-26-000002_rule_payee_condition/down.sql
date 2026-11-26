-- A rule with a payee condition has no condition left once the column goes:
-- one stored payee-only keeps a pattern that never matches, and one with a
-- text as well would match that text for every payee. Delete them rather
-- than let them widen. A rule that only also sets a payee keeps its text and
-- category; it just stops setting the payee.
DELETE FROM spending_categorization_rules WHERE payee_condition_id IS NOT NULL;
ALTER TABLE spending_categorization_rules DROP COLUMN set_payee_id;
ALTER TABLE spending_categorization_rules DROP COLUMN payee_condition_id;
