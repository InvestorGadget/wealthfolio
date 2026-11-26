-- Payees on categorization rules, beside the one (taxonomy_id, category_id)
-- target a rule already has.
--
--   payee_condition_id  the rule only matches an activity filed under this
--                       payee (taxonomy 'payees'). With it a rule can go
--                       without a text condition; it is then stored with
--                       match_type 'regex' and a pattern that never compiles,
--                       so a version that does not read this column never
--                       matches it (an empty 'contains' pattern would match
--                       every activity there).
--   set_payee_id        a payee a category rule also sets.
--
-- Neither has a foreign key. ON DELETE SET NULL would turn "only this payee"
-- into "every activity" when the payee is deleted, and RESTRICT would fail a
-- synced payee delete. Deleting a payee a rule names is refused in the
-- taxonomy service instead, and a rule that names a payee that is gone
-- neither matches nor writes it.
ALTER TABLE spending_categorization_rules ADD COLUMN payee_condition_id TEXT;
ALTER TABLE spending_categorization_rules ADD COLUMN set_payee_id TEXT;
