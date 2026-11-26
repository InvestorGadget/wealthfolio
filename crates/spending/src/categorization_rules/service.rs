use std::collections::HashMap;
use std::sync::Arc;

use crate::cash_activities::CashActivityServiceTrait;
use anyhow::Result;
use tokio::sync::Mutex;

use rust_decimal::Decimal;

use super::matcher::{
    compile_regex_pattern, compile_rules, effective_payee, match_compiled,
    match_compiled_for_taxonomy, RuleInput, RulePasses, MAX_REGEX_PATTERN_LEN,
};
use super::model::{
    is_text_condition, CategorizationRule, NewCategorizationRule, RuleAmountOp, RuleMatchType,
    UpdateCategorizationRule, NO_TEXT_CONDITION_PATTERN,
};
use super::presets::{self, ImportPresetResult, RemovePresetResult, RulePresetSummary};
use super::traits::CategorizationRulesRepositoryTrait;
use crate::activity_assignments::{
    is_category_taxonomy, ActivityTaxonomyAssignmentService, NewActivityTaxonomyAssignment,
    PAYEES_TAXONOMY,
};
use crate::error::SpendingError;

pub struct CategorizationRulesService {
    repo: Arc<dyn CategorizationRulesRepositoryTrait>,
    cash_service: Arc<dyn CashActivityServiceTrait>,
    assignment_service: Arc<ActivityTaxonomyAssignmentService>,
    /// Serializes reruns against each other. Current manual/split protection
    /// is enforced independently inside the shared assignment writer.
    rerun_lock: Arc<Mutex<()>>,
}

impl CategorizationRulesService {
    pub fn new(
        repo: Arc<dyn CategorizationRulesRepositoryTrait>,
        cash_service: Arc<dyn CashActivityServiceTrait>,
        assignment_service: Arc<ActivityTaxonomyAssignmentService>,
    ) -> Self {
        Self {
            repo,
            cash_service,
            assignment_service,
            rerun_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn list(&self) -> Result<Vec<CategorizationRule>> {
        self.repo.list().await
    }
    pub async fn get(&self, id: &str) -> Result<Option<CategorizationRule>> {
        self.repo.get(id).await
    }
    pub async fn create(&self, mut new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        validate_rule_scope(new_rule.is_global, new_rule.account_id.as_deref())?;
        // A new rule needs a condition; only rules saved by earlier versions
        // may have an empty pattern.
        normalize_new_rule_conditions(&mut new_rule, false)?;
        self.ensure_payees_exist([&new_rule.payee_condition_id, &new_rule.set_payee_id])
            .await?;
        // Normalize before validating: values without an operator are dropped,
        // and only `between` keeps an upper value.
        if new_rule.amount_op.is_none() {
            new_rule.amount_value = None;
            new_rule.amount_value2 = None;
        } else if new_rule.amount_op != Some(RuleAmountOp::Between) {
            new_rule.amount_value2 = None;
        }
        validate_rule_amount(
            new_rule.amount_op,
            new_rule.amount_value,
            new_rule.amount_value2,
        )?;
        self.repo.create(new_rule).await
    }
    pub async fn update(
        &self,
        id: &str,
        mut patch: UpdateCategorizationRule,
    ) -> Result<CategorizationRule> {
        // Resolve the post-patch (is_global, account_id) and reject contradictions.
        let existing = self
            .repo
            .get(id)
            .await?
            .ok_or_else(|| SpendingError::NotFound {
                entity: "Rule",
                id: id.to_string(),
            })?;
        let new_global = patch.is_global.unwrap_or(existing.is_global);
        let new_account = match &patch.account_id {
            Some(opt) => opt.clone(),
            None => existing.account_id.clone(),
        };
        validate_rule_scope(new_global, new_account.as_deref())?;
        // Resolve the post-patch conditions and payee fields, and validate
        // them together: which of them a rule may combine depends on its
        // target, and a rule left with no text condition is stored with the
        // placeholder pattern.
        for value in [&mut patch.payee_condition_id, &mut patch.set_payee_id]
            .into_iter()
            .flatten()
        {
            *value = non_blank(value.take());
        }
        // A rule without a text condition has no match type of its own: the
        // placeholder is stored as a regex. A patch that gives it a text
        // without naming a match type gets `contains`, like a new rule, and
        // one that only names a match type leaves it without a text.
        let (new_match_type, new_pattern) = match patch.pattern.as_deref() {
            Some(pattern) if !existing.has_text_condition() => {
                (patch.match_type.unwrap_or(RuleMatchType::Contains), pattern)
            }
            None if !existing.has_text_condition() => {
                (existing.match_type, existing.pattern.as_str())
            }
            pattern => (
                patch.match_type.unwrap_or(existing.match_type),
                pattern.unwrap_or(existing.pattern.as_str()),
            ),
        };
        let new_taxonomy = match &patch.taxonomy_id {
            Some(value) => value.as_deref(),
            None => existing.taxonomy_id.as_deref(),
        };
        let new_category = match &patch.category_id {
            Some(value) => value.as_deref(),
            None => existing.category_id.as_deref(),
        };
        let new_payee_condition = match &patch.payee_condition_id {
            Some(value) => value.as_deref(),
            None => existing.payee_condition_id.as_deref(),
        };
        let new_set_payee = match &patch.set_payee_id {
            Some(value) => value.as_deref(),
            None => existing.set_payee_id.as_deref(),
        };
        let (stored_match_type, stored_pattern) = resolve_rule_conditions(
            new_match_type,
            new_pattern,
            new_taxonomy,
            new_category,
            new_payee_condition,
            new_set_payee,
            // An empty pattern an earlier version saved can stay; a patch
            // cannot newly leave a rule with nothing to match on.
            existing.pattern.trim().is_empty(),
        )?;
        // Only a payee the patch newly names is looked up: a rule whose payee
        // has since gone can still be edited, and matches nothing meanwhile.
        let changed_payee = |patched: &Option<Option<String>>, stored: &Option<String>| {
            patched
                .as_ref()
                .filter(|value| *value != stored)
                .cloned()
                .flatten()
        };
        self.ensure_payees_exist([
            &changed_payee(&patch.payee_condition_id, &existing.payee_condition_id),
            &changed_payee(&patch.set_payee_id, &existing.set_payee_id),
        ])
        .await?;
        patch.match_type = Some(stored_match_type);
        patch.pattern = Some(stored_pattern);

        // Resolve the post-patch amount condition, normalize it (clearing the
        // operator clears both values; only `between` keeps an upper value),
        // then validate the result.
        let eff_op = patch.amount_op.unwrap_or(existing.amount_op);
        let mut eff_value = patch.amount_value.unwrap_or(existing.amount_value);
        let mut eff_value2 = patch.amount_value2.unwrap_or(existing.amount_value2);
        if eff_op.is_none() {
            if eff_value.is_some() {
                patch.amount_value = Some(None);
                eff_value = None;
            }
            if eff_value2.is_some() {
                patch.amount_value2 = Some(None);
                eff_value2 = None;
            }
        } else if eff_op != Some(RuleAmountOp::Between) && eff_value2.is_some() {
            patch.amount_value2 = Some(None);
            eff_value2 = None;
        }
        validate_rule_amount(eff_op, eff_value, eff_value2)?;
        self.repo.update(id, patch).await
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.repo.delete(id).await
    }

    pub async fn update_reviewed(
        &self,
        expected: CategorizationRule,
        mut proposed: NewCategorizationRule,
    ) -> Result<CategorizationRule> {
        if proposed.id.as_deref() != Some(expected.id.as_str())
            || proposed.preset_id != expected.preset_id
            || proposed.preset_rule_key != expected.preset_rule_key
            || proposed.preset_version != expected.preset_version
        {
            return Err(SpendingError::InvalidInput {
                message: "Rule identity and provenance must be preserved".into(),
            }
            .into());
        }
        validate_rule_scope(proposed.is_global, proposed.account_id.as_deref())?;
        normalize_new_rule_conditions(&mut proposed, expected.pattern.trim().is_empty())?;
        let changed_payee = |proposed: &Option<String>, stored: &Option<String>| {
            proposed.clone().filter(|_| proposed != stored)
        };
        self.ensure_payees_exist([
            &changed_payee(&proposed.payee_condition_id, &expected.payee_condition_id),
            &changed_payee(&proposed.set_payee_id, &expected.set_payee_id),
        ])
        .await?;
        validate_rule_amount(
            proposed.amount_op,
            proposed.amount_value,
            proposed.amount_value2,
        )?;
        let patch = UpdateCategorizationRule {
            name: Some(proposed.name),
            pattern: Some(proposed.pattern),
            match_type: Some(proposed.match_type),
            taxonomy_id: Some(proposed.taxonomy_id),
            category_id: Some(proposed.category_id),
            activity_type: Some(proposed.activity_type),
            amount_op: Some(proposed.amount_op),
            amount_value: Some(proposed.amount_value),
            amount_value2: Some(proposed.amount_value2),
            payee_condition_id: Some(proposed.payee_condition_id),
            set_payee_id: Some(proposed.set_payee_id),
            priority: Some(proposed.priority),
            is_global: Some(proposed.is_global),
            account_id: Some(proposed.account_id),
        };
        self.repo.update_reviewed(expected, patch).await
    }
    pub async fn delete_reviewed(&self, expected: CategorizationRule) -> Result<()> {
        self.repo.delete_reviewed(expected).await
    }

    /// Atomically create-or-update the rule identified by `new_rule.id`.
    /// Unlike `create`/`update`, callers must supply an explicit id — this is
    /// meant for callers (e.g. the addon bridge) that derive a stable id up
    /// front and need create-or-update to be race-free against itself,
    /// including when the same id is submitted twice in quick succession.
    ///
    /// The addon SDK cannot express a rule's payee fields, so an upsert that
    /// names neither keeps the ones the stored rule has: a payee condition the
    /// user added must not be dropped, which would widen the rule. The merged
    /// rule is validated as a whole; an addon's text beside a stored payee
    /// condition matches on both. Like earlier versions, an upsert may keep an
    /// empty pattern.
    pub async fn upsert(&self, mut new_rule: NewCategorizationRule) -> Result<CategorizationRule> {
        validate_rule_scope(new_rule.is_global, new_rule.account_id.as_deref())?;
        new_rule.payee_condition_id = non_blank(new_rule.payee_condition_id.take());
        new_rule.set_payee_id = non_blank(new_rule.set_payee_id.take());
        self.ensure_payees_exist([&new_rule.payee_condition_id, &new_rule.set_payee_id])
            .await?;
        if new_rule.payee_condition_id.is_none() && new_rule.set_payee_id.is_none() {
            if let Some(id) = new_rule.id.as_deref() {
                if let Some(stored) = self.repo.get(id).await? {
                    new_rule.payee_condition_id = stored.payee_condition_id;
                    new_rule.set_payee_id = stored.set_payee_id;
                }
            }
        }
        normalize_new_rule_conditions(&mut new_rule, true)?;
        if new_rule.amount_op.is_none() {
            new_rule.amount_value = None;
            new_rule.amount_value2 = None;
        } else if new_rule.amount_op != Some(RuleAmountOp::Between) {
            new_rule.amount_value2 = None;
        }
        validate_rule_amount(
            new_rule.amount_op,
            new_rule.amount_value,
            new_rule.amount_value2,
        )?;
        self.repo.upsert(new_rule).await
    }

    /// Re-run all rules against existing activities. Returns count of activities
    /// matched by a rule (a rule that fires counts toward the total even when it
    /// has no category target to write — matches the prior count semantics).
    /// Filters to the provided account ids when non-empty (typically the spending accounts).
    ///
    /// `only_uncategorized=true` skips activities that already have any activity-scope
    /// assignment (spending_categories or income_sources). Default safe behavior.
    /// `only_uncategorized=false` overwrites existing rule/ai/history/import-sourced
    /// assignments with the new rule target.
    ///
    /// **Manual categorizations (`source = "manual"`) are always preserved**, in
    /// both modes. A user's explicit choice should never be wiped by a rule re-run.
    pub async fn rerun_all(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<usize> {
        Ok(self
            .rerun_detailed(account_ids, only_uncategorized)
            .await?
            .matched)
    }
    pub async fn rerun_detailed(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        if account_ids.is_empty() {
            return Ok(Default::default());
        }
        let _guard = self.rerun_lock.lock().await;
        let (matched, items, incompatible, without_target) =
            self.plan_rerun(account_ids, only_uncategorized).await?;
        let mut decisions = self
            .assignment_service
            .apply_rules_detailed(items, only_uncategorized)
            .await?;
        decisions.incompatible = incompatible;
        decisions.without_target = without_target;
        Ok(super::model::CategorizationRunSummary { matched, decisions })
    }
    pub async fn preview_rerun(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<super::model::CategorizationRunSummary> {
        if account_ids.is_empty() {
            return Ok(Default::default());
        }
        let (matched, items, incompatible, without_target) =
            self.plan_rerun(account_ids, only_uncategorized).await?;
        let mut decisions = self
            .assignment_service
            .preview_rules(items, only_uncategorized)
            .await?;
        decisions.incompatible = incompatible;
        decisions.without_target = without_target;
        Ok(super::model::CategorizationRunSummary { matched, decisions })
    }

    /// Refuses a payee id that names no payee. The payee columns have no
    /// foreign key (a deleted payee must not silently widen or retarget a
    /// rule), so the service checks what it is given.
    async fn ensure_payees_exist(&self, payee_ids: [&Option<String>; 2]) -> Result<()> {
        let named: Vec<&String> = payee_ids.into_iter().flatten().collect();
        if named.is_empty() {
            return Ok(());
        }
        let known = self.cash_service.payee_ids().await?;
        if named.into_iter().any(|id| !known.contains(id)) {
            return Err(SpendingError::InvalidInput {
                message: "Unknown payee".to_string(),
            }
            .into());
        }
        Ok(())
    }

    /// Match every activity against the rules, in two passes.
    ///
    /// The payee pass comes first: payee rules, and category rules that also
    /// set a payee, give the activity its payee. The category pass then sees
    /// the payee the activity ends up with (see [`effective_payee`]): the one
    /// just planned, unless the writer will keep a payee the activity already
    /// has. That is how one run chains "text → payee" into "payee → category".
    async fn plan_rerun(
        &self,
        account_ids: &[String],
        only_uncategorized: bool,
    ) -> Result<(usize, Vec<NewActivityTaxonomyAssignment>, usize, usize)> {
        let activities = self.cash_service.list_for_rules(account_ids).await?;

        let rules = self.repo.list().await?;
        let known_payees = if RulePasses::needs_known_payees(&rules) {
            Some(self.cash_service.payee_ids().await?)
        } else {
            None
        };
        let all_compiled = compile_rules(&rules);
        let passes = RulePasses::new(&all_compiled, known_payees.as_ref());

        let mut matched_count = 0usize;
        let mut incompatible = 0;
        let mut without_target = 0;
        let mut writes: Vec<NewActivityTaxonomyAssignment> = Vec::with_capacity(activities.len());
        for row in &activities {
            let a = &row.activity;
            let notes_raw = a.notes.as_deref().unwrap_or("");
            let notes_upper = notes_raw.to_uppercase();
            let mut input = RuleInput {
                notes_upper: &notes_upper,
                notes_raw,
                activity_type: a.effective_type(),
                account_id: &a.account_id,
                amount: a.amount.map(|d| d.abs()),
                payee_id: None,
            };
            let planned_payee = passes.planned_payee(&input);
            let has_payee = planned_payee.is_some();
            if let Some(payee_id) = planned_payee {
                writes.push(NewActivityTaxonomyAssignment {
                    id: None,
                    activity_id: a.id.clone(),
                    taxonomy_id: PAYEES_TAXONOMY.to_string(),
                    category_id: payee_id.to_string(),
                    weight: 10_000,
                    source: "rule".to_string(),
                });
            }
            input.payee_id = effective_payee(&row.assignments, planned_payee, only_uncategorized);
            let Some(m) = match_compiled_for_taxonomy(
                passes.category_rules(),
                row.cash_flow_bucket.taxonomy_id(),
                &input,
            ) else {
                if match_compiled(passes.category_rules(), &input).is_some() {
                    matched_count += 1;
                    // A mismatch only explains rows it leaves uncategorized; once
                    // the row has a category in its own taxonomy, it is settled.
                    let own_taxonomy = row.cash_flow_bucket.taxonomy_id();
                    let categorized = row
                        .assignments
                        .iter()
                        .map(|assignment| assignment.taxonomy_id.as_str())
                        .chain(row.splits.iter().map(|split| split.taxonomy_id.as_str()))
                        .any(|taxonomy_id| Some(taxonomy_id) == own_taxonomy);
                    if !categorized {
                        incompatible += 1;
                    }
                } else if has_payee {
                    matched_count += 1;
                }
                continue;
            };
            matched_count += 1;
            if let (Some(tax_id), Some(cat_id)) =
                (m.rule.taxonomy_id.clone(), m.rule.category_id.clone())
            {
                writes.push(NewActivityTaxonomyAssignment {
                    id: None,
                    activity_id: a.id.clone(),
                    taxonomy_id: tax_id,
                    category_id: cat_id,
                    weight: 10_000,
                    source: "rule".to_string(),
                });
            } else {
                without_target += 1;
            }
        }

        Ok((matched_count, writes, incompatible, without_target))
    }

    /// List the bundled presets, marking which ones the user already has installed
    /// and at what version. Used by the picker UI on the rules page.
    pub async fn list_presets(&self) -> Result<Vec<RulePresetSummary>> {
        let installed_rules = self.repo.list().await?;
        let installed_versions = presets::installed_versions(
            installed_rules
                .iter()
                .map(|r| (&r.preset_id, &r.preset_version)),
        );
        Ok(presets::load_all_presets()
            .into_iter()
            .map(|p| {
                let installed_version = installed_versions.get(&p.preset_id).cloned();
                RulePresetSummary {
                    installed: installed_version.is_some(),
                    installed_version,
                    rule_count: p.rules.len(),
                    preset_id: p.preset_id,
                    preset_version: p.preset_version,
                    name: p.name,
                    description: p.description,
                    language: p.language,
                }
            })
            .collect())
    }

    /// Import a preset's rules into the user's DB. Skips rules already installed
    /// (by `(preset_id, preset_rule_key)`) and rules whose `categoryKey` doesn't
    /// resolve to a seeded category. Idempotent — safe to call repeatedly.
    ///
    /// `category_resolver` maps a category `key` (e.g. "food_groceries") to the
    /// pair `(taxonomy_id, category_id)`. Caller (typically the IPC layer)
    /// builds it from the taxonomy service.
    pub async fn import_preset(
        &self,
        preset_id: &str,
        category_resolver: &HashMap<String, (String, String)>,
    ) -> Result<ImportPresetResult> {
        let preset =
            presets::load_preset(preset_id).ok_or_else(|| SpendingError::InvalidInput {
                message: format!("Unknown preset: {preset_id}"),
            })?;

        let mut result = ImportPresetResult {
            preset_id: preset.preset_id.clone(),
            preset_version: preset.preset_version.clone(),
            total: preset.rules.len(),
            ..Default::default()
        };
        let mut rules_to_import = Vec::new();

        for rule in preset.rules {
            let Some((tax_id, cat_id)) = category_resolver.get(&rule.category_key).cloned() else {
                log::warn!(
                    "Preset '{}' rule '{}' references unknown categoryKey '{}' — skipped",
                    preset.preset_id,
                    rule.key,
                    rule.category_key,
                );
                result.skipped_unknown_category += 1;
                continue;
            };
            let match_type = RuleMatchType::try_parse(&rule.match_type).ok_or_else(|| {
                SpendingError::InvalidInput {
                    message: format!(
                        "Unknown matchType '{}' in preset '{}' rule '{}'",
                        rule.match_type, preset.preset_id, rule.key
                    ),
                }
            })?;

            let new_rule = NewCategorizationRule {
                id: None,
                name: rule.name,
                pattern: rule.pattern,
                match_type,
                taxonomy_id: Some(tax_id),
                category_id: Some(cat_id),
                activity_type: rule.activity_type,
                amount_op: None,
                amount_value: None,
                amount_value2: None,
                payee_condition_id: None,
                set_payee_id: None,
                priority: rule.priority,
                is_global: true,
                account_id: None,
                preset_id: Some(preset.preset_id.clone()),
                preset_rule_key: Some(rule.key.clone()),
                preset_version: Some(preset.preset_version.clone()),
            };
            validate_rule_pattern(&new_rule.match_type, &new_rule.pattern)?;
            rules_to_import.push(new_rule);
        }

        let counts = self
            .repo
            .import_preset_rules(&preset.preset_id, &preset.preset_version, rules_to_import)
            .await?;
        result.added = counts.added;
        result.updated = counts.updated;
        result.skipped_existing = counts.skipped_existing;
        Ok(result)
    }

    /// Uninstall a preset. Unmodified rules are deleted; user-modified rules
    /// are detached (preset metadata cleared) so the user's edits survive as
    /// standalone rules.
    pub async fn remove_preset(&self, preset_id: &str) -> Result<RemovePresetResult> {
        let (removed, kept_modified) = self.repo.remove_preset(preset_id).await?;
        Ok(RemovePresetResult {
            preset_id: preset_id.to_string(),
            removed,
            kept_modified,
        })
    }
}

/// Pure native validation for previews and reviewed rule edits.
pub fn validate_rule_input(rule: &NewCategorizationRule) -> Result<()> {
    validate_rule_scope(rule.is_global, rule.account_id.as_deref())?;
    resolve_rule_conditions(
        rule.match_type,
        &rule.pattern,
        rule.taxonomy_id.as_deref(),
        rule.category_id.as_deref(),
        non_blank(rule.payee_condition_id.clone()).as_deref(),
        non_blank(rule.set_payee_id.clone()).as_deref(),
        // Whether the pattern may be empty depends on the rule it edits; the
        // service checks that against the stored rule.
        true,
    )?;
    validate_rule_amount(rule.amount_op, rule.amount_value, rule.amount_value2)
}

fn non_blank(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Validate a whole new rule's conditions and payee fields, and give it the
/// pattern it is stored with (see [`resolve_rule_conditions`]).
fn normalize_new_rule_conditions(
    rule: &mut NewCategorizationRule,
    empty_pattern_allowed: bool,
) -> Result<()> {
    rule.payee_condition_id = non_blank(rule.payee_condition_id.take());
    rule.set_payee_id = non_blank(rule.set_payee_id.take());
    let (match_type, pattern) = resolve_rule_conditions(
        rule.match_type,
        &rule.pattern,
        rule.taxonomy_id.as_deref(),
        rule.category_id.as_deref(),
        rule.payee_condition_id.as_deref(),
        rule.set_payee_id.as_deref(),
        empty_pattern_allowed,
    )?;
    rule.match_type = match_type;
    rule.pattern = pattern;
    Ok(())
}

/// Validate what a rule matches on and which payee it may set, and return the
/// `(match_type, pattern)` to store.
///
/// - A rule needs a text condition or a payee condition. With a payee
///   condition and an empty text it is stored as a regex with
///   [`NO_TEXT_CONDITION_PATTERN`], so a version that does not know payee
///   conditions never matches it. That placeholder without a payee condition
///   is refused.
/// - An empty text without a payee condition matches every activity in the
///   rule's scope. Earlier versions saved such rules, so they stay valid
///   where `empty_pattern_allowed` (an edit of one, an upsert); a new rule
///   cannot have one.
/// - A rule that matches on a payee cannot set one: the payee pass runs
///   before payees are known, so such a rule could never fire there.
/// - Only a rule that targets a category can also set a payee; a payee rule
///   already sets one as its target.
fn resolve_rule_conditions(
    match_type: RuleMatchType,
    pattern: &str,
    taxonomy_id: Option<&str>,
    category_id: Option<&str>,
    payee_condition_id: Option<&str>,
    set_payee_id: Option<&str>,
    empty_pattern_allowed: bool,
) -> Result<(RuleMatchType, String)> {
    let invalid = |message: &str| -> anyhow::Error {
        SpendingError::InvalidInput {
            message: message.to_string(),
        }
        .into()
    };
    if payee_condition_id.is_some()
        && (set_payee_id.is_some() || taxonomy_id == Some(PAYEES_TAXONOMY))
    {
        return Err(invalid("A rule with a payee condition cannot set a payee"));
    }
    if set_payee_id.is_some()
        && !(category_id.is_some() && taxonomy_id.is_some_and(is_category_taxonomy))
    {
        return Err(invalid(
            "Only a rule that sets a category can also set a payee",
        ));
    }
    let no_text = !is_text_condition(match_type, pattern) || pattern.trim().is_empty();
    if !no_text {
        validate_rule_pattern(&match_type, pattern)?;
        return Ok((match_type, pattern.to_string()));
    }
    if payee_condition_id.is_some() {
        return Ok((RuleMatchType::Regex, NO_TEXT_CONDITION_PATTERN.to_string()));
    }
    if empty_pattern_allowed && is_text_condition(match_type, pattern) {
        return Ok((match_type, pattern.to_string()));
    }
    Err(invalid(
        "A rule needs a text condition or a payee condition",
    ))
}

fn validate_rule_pattern(match_type: &RuleMatchType, pattern: &str) -> Result<()> {
    if !matches!(match_type, RuleMatchType::Regex) {
        return Ok(());
    }
    if pattern.len() > MAX_REGEX_PATTERN_LEN {
        return Err(SpendingError::InvalidInput {
            message: format!("Regex pattern must be {MAX_REGEX_PATTERN_LEN} characters or fewer"),
        }
        .into());
    }
    compile_regex_pattern(pattern).map_err(|err| SpendingError::InvalidInput {
        message: format!("Invalid regex pattern: {err}"),
    })?;
    Ok(())
}

/// Validate a normalized amount condition. Callers normalize first (no
/// operator ⇒ no values, non-`between` ⇒ no upper value), so this only has to
/// check what the user could still get wrong.
fn validate_rule_amount(
    op: Option<RuleAmountOp>,
    value: Option<Decimal>,
    value2: Option<Decimal>,
) -> Result<()> {
    let Some(op) = op else {
        return Ok(());
    };
    let Some(value) = value else {
        return Err(SpendingError::InvalidInput {
            message: "Amount condition requires a value".to_string(),
        }
        .into());
    };
    if value < Decimal::ZERO || value2.is_some_and(|v| v < Decimal::ZERO) {
        return Err(SpendingError::InvalidInput {
            message: "Amount values cannot be negative".to_string(),
        }
        .into());
    }
    if op == RuleAmountOp::Between {
        let Some(value2) = value2 else {
            return Err(SpendingError::InvalidInput {
                message: "Between amount condition requires an upper value".to_string(),
            }
            .into());
        };
        if value > value2 {
            return Err(SpendingError::InvalidInput {
                message: "Amount range lower value must be less than or equal to the upper value"
                    .to_string(),
            }
            .into());
        }
    }
    Ok(())
}

fn validate_rule_scope(is_global: bool, account_id: Option<&str>) -> Result<()> {
    if is_global && account_id.is_some() {
        return Err(SpendingError::GlobalRuleHasAccount.into());
    }
    if !is_global && account_id.unwrap_or_default().is_empty() {
        return Err(SpendingError::InvalidInput {
            message: "Account-scoped rules require accountId".to_string(),
        }
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_assignments::{
        ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentRepositoryTrait,
    };
    use async_trait::async_trait;
    use chrono::{DateTime, NaiveDate, Utc};
    use std::sync::Mutex;
    use wealthfolio_core::activities::ActivityRepositoryTrait;
    use wealthfolio_core::activities::{
        Activity, ActivityBulkMutationResult, ActivitySearchResponse, ActivityStatus,
        ActivityUpdate, ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate,
        IncomeData, NewActivity, Sort,
    };
    use wealthfolio_core::limits::ContributionActivity;

    struct MockRulesRepo {
        rules: Mutex<Vec<CategorizationRule>>,
    }

    #[async_trait]
    impl CategorizationRulesRepositoryTrait for MockRulesRepo {
        async fn update_reviewed(
            &self,
            expected: CategorizationRule,
            patch: UpdateCategorizationRule,
        ) -> Result<CategorizationRule> {
            self.update(&expected.id, patch).await
        }
        async fn delete_reviewed(&self, _: CategorizationRule) -> Result<()> {
            unimplemented!("reviewed rule")
        }

        async fn list(&self) -> Result<Vec<CategorizationRule>> {
            Ok(self.rules.lock().unwrap().clone())
        }
        async fn get(&self, id: &str) -> Result<Option<CategorizationRule>> {
            Ok(self
                .rules
                .lock()
                .unwrap()
                .iter()
                .find(|rule| rule.id == id)
                .cloned())
        }
        async fn create(&self, n: NewCategorizationRule) -> Result<CategorizationRule> {
            let now = Utc::now().naive_utc();
            let rule = CategorizationRule {
                id: n.id.unwrap_or_else(|| {
                    format!("rule-{}", now.and_utc().timestamp_nanos_opt().unwrap())
                }),
                name: n.name,
                pattern: n.pattern,
                match_type: n.match_type,
                taxonomy_id: n.taxonomy_id,
                category_id: n.category_id,
                activity_type: n.activity_type,
                amount_op: n.amount_op,
                amount_value: n.amount_value,
                amount_value2: n.amount_value2,
                payee_condition_id: n.payee_condition_id,
                set_payee_id: n.set_payee_id,
                priority: n.priority,
                is_global: n.is_global,
                account_id: n.account_id,
                preset_id: n.preset_id,
                preset_rule_key: n.preset_rule_key,
                preset_version: n.preset_version,
                preset_modified: false,
                created_at: now,
                updated_at: now,
            };
            self.rules.lock().unwrap().push(rule.clone());
            Ok(rule)
        }
        async fn update(
            &self,
            id: &str,
            p: UpdateCategorizationRule,
        ) -> Result<CategorizationRule> {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| rule.id == id)
                .expect("rule exists");
            if let Some(v) = p.name {
                rule.name = v;
            }
            if let Some(v) = p.pattern {
                rule.pattern = v;
            }
            if let Some(v) = p.match_type {
                rule.match_type = v;
            }
            if let Some(v) = p.taxonomy_id {
                rule.taxonomy_id = v;
            }
            if let Some(v) = p.category_id {
                rule.category_id = v;
            }
            if let Some(v) = p.activity_type {
                rule.activity_type = v;
            }
            if let Some(v) = p.amount_op {
                rule.amount_op = v;
            }
            if let Some(v) = p.amount_value {
                rule.amount_value = v;
            }
            if let Some(v) = p.amount_value2 {
                rule.amount_value2 = v;
            }
            if let Some(v) = p.payee_condition_id {
                rule.payee_condition_id = v;
            }
            if let Some(v) = p.set_payee_id {
                rule.set_payee_id = v;
            }
            if let Some(v) = p.priority {
                rule.priority = v;
            }
            if let Some(v) = p.is_global {
                rule.is_global = v;
            }
            if let Some(v) = p.account_id {
                rule.account_id = v;
            }
            rule.updated_at = Utc::now().naive_utc();
            Ok(rule.clone())
        }
        async fn upsert(&self, n: NewCategorizationRule) -> Result<CategorizationRule> {
            let id = n.id.clone().expect("upsert requires an explicit id");
            let exists = self.rules.lock().unwrap().iter().any(|rule| rule.id == id);
            if exists {
                let patch = UpdateCategorizationRule {
                    name: Some(n.name),
                    pattern: Some(n.pattern),
                    match_type: Some(n.match_type),
                    taxonomy_id: Some(n.taxonomy_id),
                    category_id: Some(n.category_id),
                    activity_type: Some(n.activity_type),
                    amount_op: Some(n.amount_op),
                    amount_value: Some(n.amount_value),
                    amount_value2: Some(n.amount_value2),
                    payee_condition_id: Some(n.payee_condition_id),
                    set_payee_id: Some(n.set_payee_id),
                    priority: Some(n.priority),
                    is_global: Some(n.is_global),
                    account_id: Some(n.account_id),
                };
                self.update(&id, patch).await
            } else {
                self.create(n).await
            }
        }
        async fn import_preset_rules(
            &self,
            preset_id: &str,
            preset_version: &str,
            new_rules: Vec<NewCategorizationRule>,
        ) -> Result<crate::categorization_rules::PresetImportCounts> {
            let mut rules = self.rules.lock().unwrap();
            let mut counts = crate::categorization_rules::PresetImportCounts::default();
            for n in new_rules {
                let Some(rule_key) = n.preset_rule_key.clone() else {
                    continue;
                };
                let existing = rules.iter_mut().find(|rule| {
                    rule.preset_id.as_deref() == Some(preset_id)
                        && rule.preset_rule_key.as_deref() == Some(rule_key.as_str())
                });
                if let Some(existing) = existing {
                    if existing.preset_modified
                        || existing.preset_version.as_deref() == Some(preset_version)
                    {
                        counts.skipped_existing += 1;
                        continue;
                    }
                    existing.name = n.name;
                    existing.pattern = n.pattern;
                    existing.match_type = n.match_type;
                    existing.taxonomy_id = n.taxonomy_id;
                    existing.category_id = n.category_id;
                    existing.activity_type = n.activity_type;
                    existing.amount_op = n.amount_op;
                    existing.amount_value = n.amount_value;
                    existing.amount_value2 = n.amount_value2;
                    existing.priority = n.priority;
                    existing.is_global = n.is_global;
                    existing.account_id = n.account_id;
                    existing.preset_id = n.preset_id;
                    existing.preset_rule_key = n.preset_rule_key;
                    existing.preset_version = n.preset_version;
                    existing.preset_modified = false;
                    existing.updated_at = Utc::now().naive_utc();
                    counts.updated += 1;
                    continue;
                }

                let now = Utc::now().naive_utc();
                rules.push(CategorizationRule {
                    id: n.id.unwrap_or_else(|| {
                        format!("rule-{}", now.and_utc().timestamp_nanos_opt().unwrap())
                    }),
                    name: n.name,
                    pattern: n.pattern,
                    match_type: n.match_type,
                    taxonomy_id: n.taxonomy_id,
                    category_id: n.category_id,
                    activity_type: n.activity_type,
                    amount_op: n.amount_op,
                    amount_value: n.amount_value,
                    amount_value2: n.amount_value2,
                    payee_condition_id: n.payee_condition_id,
                    set_payee_id: n.set_payee_id,
                    priority: n.priority,
                    is_global: n.is_global,
                    account_id: n.account_id,
                    preset_id: n.preset_id,
                    preset_rule_key: n.preset_rule_key,
                    preset_version: n.preset_version,
                    preset_modified: false,
                    created_at: now,
                    updated_at: now,
                });
                counts.added += 1;
            }
            Ok(counts)
        }
        async fn delete(&self, _id: &str) -> Result<()> {
            unimplemented!()
        }
        async fn remove_preset(&self, _id: &str) -> Result<(usize, usize)> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockAssignmentRepo {
        existing: Mutex<Vec<ActivityTaxonomyAssignment>>,
        writes: Mutex<Vec<NewActivityTaxonomyAssignment>>,
    }

    #[async_trait]
    impl ActivityTaxonomyAssignmentRepositoryTrait for MockAssignmentRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn list_for_activities(
            &self,
            ids: &[String],
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            let id_set: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
            Ok(self
                .existing
                .lock()
                .unwrap()
                .iter()
                .filter(|a| id_set.contains(a.activity_id.as_str()))
                .cloned()
                .collect())
        }
        async fn upsert(
            &self,
            _: NewActivityTaxonomyAssignment,
        ) -> Result<ActivityTaxonomyAssignment> {
            unimplemented!()
        }
        async fn assign_many_single_select(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            self.writes.lock().unwrap().extend(items.iter().cloned());
            // Mirror real DB: a successful write becomes visible to subsequent
            // `list_for_activities` calls. Replaces any prior row with the
            // same (activity_id, taxonomy_id) pair to match the storage layer's
            // single-select delete-then-insert semantics.
            let rows: Vec<ActivityTaxonomyAssignment> = items
                .into_iter()
                .map(|n| ActivityTaxonomyAssignment {
                    id: format!("row-{}-{}", n.activity_id, n.taxonomy_id),
                    activity_id: n.activity_id,
                    taxonomy_id: n.taxonomy_id,
                    category_id: n.category_id,
                    weight: n.weight,
                    source: n.source,
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                })
                .collect();
            {
                let mut existing = self.existing.lock().unwrap();
                for row in &rows {
                    existing.retain(|a| {
                        !(a.activity_id == row.activity_id && a.taxonomy_id == row.taxonomy_id)
                    });
                    existing.push(row.clone());
                }
            }
            Ok(rows)
        }

        async fn assign_many_single_select_clearing_splits(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
            _: std::collections::HashMap<String, Vec<crate::activity_splits::ActivitySplit>>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            self.assign_many_single_select(items).await
        }
        async fn assign_rule_many_single_select(
            &self,
            items: Vec<NewActivityTaxonomyAssignment>,
            only_uncategorized: bool,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            let mut rows = Vec::new();
            let mut existing = self.existing.lock().unwrap();
            for item in items {
                let current: Vec<ActivityTaxonomyAssignment> = existing
                    .iter()
                    .filter(|a| {
                        a.activity_id == item.activity_id && a.taxonomy_id == item.taxonomy_id
                    })
                    .cloned()
                    .collect();
                if current
                    .iter()
                    .any(|a| a.source.eq_ignore_ascii_case("manual"))
                {
                    continue;
                }
                if only_uncategorized && !current.is_empty() {
                    continue;
                }
                self.writes.lock().unwrap().push(item.clone());
                let row = ActivityTaxonomyAssignment {
                    id: format!("row-{}-{}", item.activity_id, item.taxonomy_id),
                    activity_id: item.activity_id,
                    taxonomy_id: item.taxonomy_id,
                    category_id: item.category_id,
                    weight: item.weight,
                    source: item.source,
                    created_at: Utc::now().naive_utc(),
                    updated_at: Utc::now().naive_utc(),
                };
                existing.retain(|a| {
                    !(a.activity_id == row.activity_id && a.taxonomy_id == row.taxonomy_id)
                });
                existing.push(row.clone());
                rows.push(row);
            }
            Ok(rows)
        }
        async fn reassign_category(&self, _: &str, _: &str, _: &str) -> Result<usize> {
            unimplemented!()
        }
        async fn delete(&self, _id: &str) -> Result<()> {
            unimplemented!()
        }
        async fn clear_for_taxonomy(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }
    }

    #[async_trait]
    impl CashActivityServiceTrait for MockActivityRepo {
        /// The payees the tests know. `payee_gone` is left out on purpose.
        async fn payee_ids(&self) -> Result<std::collections::HashSet<String>> {
            Ok(["payee_bakery", "payee_amazon", "payee_netflix"]
                .into_iter()
                .map(str::to_string)
                .collect())
        }
        async fn list_for_rules(
            &self,
            account_ids: &[String],
        ) -> Result<Vec<crate::cash_activities::CashActivity>> {
            let all = self
                .activities
                .iter()
                .filter(|a| account_ids.contains(&a.account_id))
                .collect::<Vec<_>>();
            let groups = crate::activity_classification::within_spending_transfer_groups(&all);
            all.into_iter()
                .map(|a| {
                    let classification =
                        crate::activity_classification::classify_activity_for_aggregation(
                            a,
                            wealthfolio_core::accounts::account_types::CASH,
                            &groups,
                        );
                    let bucket = if classification.income_amount(Decimal::ONE) != Decimal::ZERO {
                        "income"
                    } else if classification.saving_amount(Decimal::ONE) != Decimal::ZERO {
                        "saving"
                    } else if classification.spending_amount(Decimal::ONE) != Decimal::ZERO {
                        "spending"
                    } else {
                        "neutral"
                    };
                    let mut row = serde_json::to_value(a)?;
                    row["cashFlowBucket"] = serde_json::json!(bucket);
                    row["assignments"] = serde_json::to_value(
                        self.assignments
                            .iter()
                            .filter(|assignment| assignment.activity_id == a.id)
                            .collect::<Vec<_>>(),
                    )?;
                    row["splits"] = serde_json::json!([]);
                    row["netAmount"] = serde_json::json!(0.0);
                    row["visibleSpendingAmount"] = serde_json::json!(0.0);
                    serde_json::from_value(row).map_err(Into::into)
                })
                .collect()
        }
        async fn context(&self) -> Result<crate::cash_activities::SpendingContext> {
            unimplemented!()
        }
        async fn search(
            &self,
            _: crate::cash_activities::CashActivitySearchRequest,
        ) -> Result<crate::cash_activities::CashActivitySearchResponse> {
            unimplemented!()
        }
        async fn get_by_activity_ids(
            &self,
            _: &[String],
        ) -> Result<Vec<crate::cash_activities::CashActivity>> {
            unimplemented!()
        }
        async fn bulk_assign_categories(
            &self,
            _: &[crate::activity_assignments::BulkCategoryAssignment],
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn spending_account_ids(&self) -> Result<Vec<String>> {
            unimplemented!()
        }
        async fn validate_splits(
            &self,
            _: &str,
            _: &[crate::activity_splits::NewActivitySplit],
        ) -> Result<()> {
            unimplemented!()
        }
        async fn replace_splits_reviewed(
            &self,
            _: crate::activity_splits::SplitReviewState,
            _: Vec<crate::activity_splits::NewActivitySplit>,
        ) -> Result<Vec<crate::activity_splits::ActivitySplit>> {
            unimplemented!()
        }
        async fn set_event_reviewed(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<String>,
        ) -> Result<()> {
            unimplemented!()
        }
    }

    struct MockActivityRepo {
        activities: Vec<Activity>,
        /// Activity-scope assignments the rows carry, as `list_for_rules` loads them.
        assignments: Vec<ActivityTaxonomyAssignment>,
    }

    fn mk_activity(id: &str, account: &str, notes: &str) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account.to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: Some(notes.to_string()),
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepo {
        fn get_activity(&self, _: &str) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        fn get_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }
        fn get_activities_by_account_id(&self, _: &str) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_activities_by_account_ids(
            &self,
            ids: &[String],
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            let set: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
            Ok(self
                .activities
                .iter()
                .filter(|a| set.contains(a.account_id.as_str()))
                .cloned()
                .collect())
        }
        fn get_trading_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_income_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }
        fn get_contribution_activities(
            &self,
            _: &[String],
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> wealthfolio_core::Result<Vec<ContributionActivity>> {
            unimplemented!()
        }
        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<NaiveDate>,
            _: Option<NaiveDate>,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
        ) -> wealthfolio_core::Result<ActivitySearchResponse> {
            unimplemented!()
        }
        async fn create_activity(&self, _: NewActivity) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn update_activity(&self, _: ActivityUpdate) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn delete_activity(&self, _: String) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }
        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }
        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> wealthfolio_core::Result<ActivityBulkMutationResult> {
            unimplemented!()
        }
        async fn create_activities(&self, _: Vec<NewActivity>) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
        fn get_first_activity_date(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }
        fn get_import_mapping(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportMapping>> {
            unimplemented!()
        }
        async fn save_import_mapping(&self, _: &ImportMapping) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_account_template(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn list_import_templates(&self) -> wealthfolio_core::Result<Vec<ImportTemplate>> {
            unimplemented!()
        }
        fn get_import_template(&self, _: &str) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_import_template(&self, _: &ImportTemplate) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn delete_import_template(&self, _: &str) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn get_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }
        async fn save_broker_sync_profile(
            &self,
            _: &ImportTemplate,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        async fn link_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }
        fn get_income_activities_data(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<IncomeData>> {
            unimplemented!()
        }
        fn get_first_activity_date_overall(&self) -> wealthfolio_core::Result<DateTime<Utc>> {
            unimplemented!()
        }
        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>
        {
            unimplemented!()
        }
        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>>
        {
            unimplemented!()
        }
        fn check_existing_duplicates(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<HashMap<String, String>> {
            unimplemented!()
        }
        async fn bulk_upsert(
            &self,
            _: Vec<ActivityUpsert>,
        ) -> wealthfolio_core::Result<BulkUpsertResult> {
            unimplemented!()
        }
        async fn reassign_asset(&self, _: &str, _: &str) -> wealthfolio_core::Result<u32> {
            unimplemented!()
        }
        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<(Vec<String>, Vec<String>)> {
            unimplemented!()
        }
    }

    fn mk_rule(id: &str, pattern: &str, tax: &str, cat: &str, priority: i32) -> CategorizationRule {
        CategorizationRule {
            id: id.to_string(),
            name: id.to_string(),
            pattern: pattern.to_string(),
            match_type: RuleMatchType::Contains,
            taxonomy_id: Some(tax.to_string()),
            category_id: Some(cat.to_string()),
            activity_type: None,
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            payee_condition_id: None,
            set_payee_id: None,
            priority,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
            preset_modified: false,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    fn mk_assignment(
        activity_id: &str,
        tax: &str,
        cat: &str,
        source: &str,
    ) -> ActivityTaxonomyAssignment {
        ActivityTaxonomyAssignment {
            id: format!("a-{activity_id}-{tax}"),
            activity_id: activity_id.to_string(),
            taxonomy_id: tax.to_string(),
            category_id: cat.to_string(),
            weight: 10_000,
            source: source.to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[tokio::test]
    async fn incompatible_savings_rule_does_not_block_a_spending_rule() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![
                mk_rule(
                    "savings",
                    "TRANSFER",
                    "savings_categories",
                    "cat_savings_investments",
                    10,
                ),
                mk_rule(
                    "spending",
                    "TRANSFER",
                    "spending_categories",
                    "cat_other",
                    1,
                ),
            ]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("withdrawal", "acct1", "TRANSFER TO BROKER")],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo,
            activity_repo,
            Arc::new(ActivityTaxonomyAssignmentService::new(
                assignment_repo.clone(),
            )),
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(summary.matched, 1);
        assert_eq!(summary.decisions.changed, 1);
        assert_eq!(summary.decisions.incompatible, 0);
        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].category_id, "cat_other");
    }

    #[tokio::test]
    async fn payee_rule_sets_a_payee_beside_the_category_rule() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![
                // The payee rule has the higher priority, and must not win
                // the category away from the spending rule.
                mk_rule("payee", "BAKERY", PAYEES_TAXONOMY, "payee_bakery", 10),
                mk_rule("spending", "BAKERY", "spending_categories", "cat_food", 1),
            ]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let mut deposit = mk_activity("deposit", "acct1", "BAKERY REFUND");
        deposit.activity_type = "DEPOSIT".to_string();
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![
                mk_activity("withdrawal", "acct1", "CORNER BAKERY 12"),
                // An income row: the spending rule cannot apply, the payee can.
                deposit,
                mk_activity("other", "acct1", "CITY WATER"),
            ],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo,
            activity_repo,
            Arc::new(ActivityTaxonomyAssignmentService::new(
                assignment_repo.clone(),
            )),
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        // Each matched activity counts once, however many rules fired on it.
        assert_eq!(summary.matched, 2);
        let mut writes: Vec<(String, String, String)> = assignment_repo
            .writes
            .lock()
            .unwrap()
            .iter()
            .map(|w| {
                (
                    w.activity_id.clone(),
                    w.taxonomy_id.clone(),
                    w.category_id.clone(),
                )
            })
            .collect();
        writes.sort();
        let row = |a: &str, t: &str, c: &str| (a.to_string(), t.to_string(), c.to_string());
        assert_eq!(
            writes,
            vec![
                row("deposit", PAYEES_TAXONOMY, "payee_bakery"),
                row("withdrawal", PAYEES_TAXONOMY, "payee_bakery"),
                row("withdrawal", "spending_categories", "cat_food"),
            ]
        );
    }

    #[tokio::test]
    async fn savings_rules_report_incompatible_withdrawals_and_accept_linked_transfers() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![mk_rule(
                "savings",
                "BROKER",
                "savings_categories",
                "cat_savings_investments",
                10,
            )]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let withdrawal = mk_activity("withdrawal", "acct1", "BROKER");
        let mut unlinked = mk_activity("unlinked", "acct1", "BROKER");
        unlinked.activity_type = "TRANSFER_OUT".to_string();
        let mut linked = unlinked.clone();
        linked.id = "linked".to_string();
        // The counterpart is outside the Spending scope, so only this leg is loaded.
        linked.source_group_id = Some("investment-transfer".to_string());
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![withdrawal, unlinked, linked],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo,
            activity_repo,
            Arc::new(ActivityTaxonomyAssignmentService::new(
                assignment_repo.clone(),
            )),
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(summary.matched, 3);
        assert_eq!(summary.decisions.changed, 1);
        assert_eq!(summary.decisions.incompatible, 2);
        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].activity_id, "linked");
        assert_eq!(writes[0].taxonomy_id, "savings_categories");
    }

    #[tokio::test]
    async fn incompatible_matches_skip_rows_categorized_in_their_own_taxonomy() {
        // A spending rule matching refund deposits, which are income.
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![mk_rule(
                "shopping",
                "AMZN",
                "spending_categories",
                "cat_shopping",
                10,
            )]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let mut categorized = mk_activity("categorized", "acct1", "AMZN REFUND");
        categorized.activity_type = "DEPOSIT".to_string();
        let mut uncategorized = categorized.clone();
        uncategorized.id = "uncategorized".to_string();
        let now = Utc::now().naive_utc();
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![categorized, uncategorized],
            assignments: vec![ActivityTaxonomyAssignment {
                id: "manual-income".to_string(),
                activity_id: "categorized".to_string(),
                taxonomy_id: "income_sources".to_string(),
                category_id: "cat_income_other".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
                created_at: now,
                updated_at: now,
            }],
        });
        let svc = CategorizationRulesService::new(
            rules_repo,
            activity_repo,
            Arc::new(ActivityTaxonomyAssignmentService::new(
                assignment_repo.clone(),
            )),
        );

        for only_uncategorized in [true, false] {
            let summary = svc
                .rerun_detailed(&["acct1".to_string()], only_uncategorized)
                .await
                .unwrap();
            // Both still match, so the legacy numeric result is unchanged.
            assert_eq!(summary.matched, 2);
            assert_eq!(summary.decisions.incompatible, 1);
        }
        assert!(assignment_repo.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rerun_does_not_skip_cross_taxonomy_for_manual_income() {
        // Activity has a manual income_sources assignment and NO spending_categories
        // assignment. A rule targeting spending_categories should still apply.
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo {
            existing: Mutex::new(vec![mk_assignment(
                "act1",
                "income_sources",
                "src_paycheck",
                "manual",
            )]),
            writes: Mutex::new(vec![]),
        });
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
            assignments: vec![],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let matched = svc
            .rerun_all(&["acct1".to_string()], /* only_uncategorized */ false)
            .await
            .unwrap();
        assert_eq!(matched, 1, "rule should have matched");

        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(
            writes.len(),
            1,
            "spending_categories assignment should be written"
        );
        assert_eq!(writes[0].activity_id, "act1");
        assert_eq!(writes[0].taxonomy_id, "spending_categories");
        assert_eq!(writes[0].category_id, "cat_food");

        // The existing manual income_sources row is untouched — nothing was
        // written targeting (act1, income_sources).
        assert!(!writes.iter().any(|w| w.taxonomy_id == "income_sources"));
        let still_there = assignment_repo
            .existing
            .lock()
            .unwrap()
            .iter()
            .any(|a| a.taxonomy_id == "income_sources" && a.source == "manual");
        assert!(still_there);
    }

    #[tokio::test]
    async fn rerun_preserves_manual_same_taxonomy() {
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo {
            existing: Mutex::new(vec![mk_assignment(
                "act1",
                "spending_categories",
                "cat_other",
                "manual",
            )]),
            writes: Mutex::new(vec![]),
        });
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
            assignments: vec![],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let _ = svc.rerun_all(&["acct1".to_string()], false).await.unwrap();
        let writes = assignment_repo.writes.lock().unwrap();
        assert!(
            writes.is_empty(),
            "manual same-taxonomy must block the rule"
        );
    }

    #[tokio::test]
    async fn concurrent_rerun_all_do_not_interleave() {
        // Two reruns are spawned concurrently against the same single matching
        // activity with `only_uncategorized=true`. With the rerun_lock in place,
        // the first rerun's write becomes visible to the second's skip-set
        // (the mock now mirrors writes into `existing`), so the second rerun
        // writes nothing. Without the lock, both skip-sets are built before
        // either write fires and the activity is written twice.
        let rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 10);
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![rule]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![mk_activity("act1", "acct1", "AMAZON ORDER #123")],
            assignments: vec![],
        });
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let svc = Arc::new(CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        ));

        let svc_a = svc.clone();
        let svc_b = svc.clone();
        let (a, b) = tokio::join!(
            tokio::spawn(async move {
                svc_a
                    .rerun_all(&["acct1".to_string()], /* only_uncategorized */ true)
                    .await
            }),
            tokio::spawn(async move {
                svc_b
                    .rerun_all(&["acct1".to_string()], /* only_uncategorized */ true)
                    .await
            }),
        );
        a.unwrap().unwrap();
        b.unwrap().unwrap();

        let writes = assignment_repo.writes.lock().unwrap();
        assert_eq!(
            writes.len(),
            1,
            "with serialized reruns, the second rerun's skip-set must see the first's write and skip — got {} writes ({:?})",
            writes.len(),
            writes
                .iter()
                .map(|w| (w.activity_id.clone(), w.taxonomy_id.clone()))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn create_rejects_global_with_account_id() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "x".to_string(),
                pattern: "AMAZON".to_string(),
                match_type: RuleMatchType::Contains,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                amount_op: None,
                amount_value: None,
                amount_value2: None,
                payee_condition_id: None,
                set_payee_id: None,
                priority: 1,
                is_global: true,
                account_id: Some("acct1".to_string()),
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("global rule cannot also have an account_id"));
    }

    #[tokio::test]
    async fn create_rejects_account_scope_without_account_id() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "x".to_string(),
                pattern: "AMAZON".to_string(),
                match_type: RuleMatchType::Contains,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                amount_op: None,
                amount_value: None,
                amount_value2: None,
                payee_condition_id: None,
                set_payee_id: None,
                priority: 1,
                is_global: false,
                account_id: None,
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("Account-scoped rules require accountId"));
    }

    #[tokio::test]
    async fn create_rejects_invalid_regex_pattern() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let err = svc
            .create(NewCategorizationRule {
                id: None,
                name: "bad regex".to_string(),
                pattern: "(unclosed".to_string(),
                match_type: RuleMatchType::Regex,
                taxonomy_id: Some("spending_categories".to_string()),
                category_id: Some("cat_food".to_string()),
                activity_type: None,
                amount_op: None,
                amount_value: None,
                amount_value2: None,
                payee_condition_id: None,
                set_payee_id: None,
                priority: 1,
                is_global: true,
                account_id: None,
                preset_id: None,
                preset_rule_key: None,
                preset_version: None,
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Invalid regex pattern"));
    }

    #[tokio::test]
    async fn update_rejects_invalid_regex_pattern() {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![mk_rule(
                "rule-1",
                "AMAZON",
                "spending_categories",
                "cat_food",
                1,
            )]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );

        let err = svc
            .update(
                "rule-1",
                UpdateCategorizationRule {
                    pattern: Some("(unclosed".to_string()),
                    match_type: Some(RuleMatchType::Regex),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Invalid regex pattern"));
    }

    #[tokio::test]
    async fn import_preset_upgrades_unmodified_old_version_rule() {
        let preset = presets::load_preset("us").unwrap();
        let preset_rule = preset.rules.first().unwrap();
        let mut installed = mk_rule(
            "installed-rule",
            "OLD PATTERN",
            "spending_categories",
            "old_cat",
            1,
        );
        installed.preset_id = Some(preset.preset_id.clone());
        installed.preset_rule_key = Some(preset_rule.key.clone());
        installed.preset_version = Some("0.0.0".to_string());
        installed.preset_modified = false;

        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(vec![installed]),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![],
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo.clone() as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );
        let mut resolver = HashMap::new();
        resolver.insert(
            preset_rule.category_key.clone(),
            ("spending_categories".to_string(), "new_cat".to_string()),
        );

        let result = svc.import_preset("us", &resolver).await.unwrap();

        assert_eq!(result.updated, 1);
        let rules = rules_repo.rules.lock().unwrap();
        let updated_rule = rules
            .iter()
            .find(|rule| rule.id == "installed-rule")
            .unwrap();
        assert_eq!(updated_rule.pattern, preset_rule.pattern);
        assert_eq!(updated_rule.priority, preset_rule.priority);
        assert_eq!(updated_rule.category_id.as_deref(), Some("new_cat"));
        assert_eq!(
            updated_rule.preset_version.as_deref(),
            Some(preset.preset_version.as_str())
        );
        assert!(!updated_rule.preset_modified);
    }

    #[tokio::test]
    async fn french_preset_upgrade_preserves_user_edits_and_is_idempotent() {
        let preset = presets::load_preset("fr").unwrap();
        assert_ne!(preset.preset_version, "2026-09.1");
        let mut electronics = mk_rule(
            "installed-electronics",
            "(?i)boulanger",
            "spending_categories",
            "shopping_electronics",
            82,
        );
        electronics.match_type = RuleMatchType::Regex;
        electronics.preset_id = Some("fr".to_string());
        electronics.preset_rule_key = Some("fr.electronics".to_string());
        electronics.preset_version = Some("2026-09.1".to_string());

        let mut edited = mk_rule(
            "edited-home",
            "CUSTOM ACTION RULE",
            "spending_categories",
            "shopping_home",
            99,
        );
        edited.preset_id = Some("fr".to_string());
        edited.preset_rule_key = Some("fr.home_goods".to_string());
        edited.preset_version = Some("2026-09.1".to_string());
        edited.preset_modified = true;

        let (svc, repo, _) = mk_svc(vec![electronics, edited.clone()], vec![]);
        let resolver = preset
            .rules
            .iter()
            .map(|rule| {
                (
                    rule.category_key.clone(),
                    ("spending_categories".to_string(), rule.category_key.clone()),
                )
            })
            .collect();

        let result = svc.import_preset("fr", &resolver).await.unwrap();
        assert_eq!(result.added, preset.rules.len() - 2);
        assert_eq!(result.updated, 1);
        assert_eq!(result.skipped_existing, 1);
        assert_eq!(result.skipped_unknown_category, 0);

        let upgraded = repo.get("installed-electronics").await.unwrap().unwrap();
        assert_eq!(
            upgraded.preset_version.as_deref(),
            Some(preset.preset_version.as_str())
        );
        assert!(upgraded.pattern.contains(r"\bboulanger\b"));
        let preserved = repo.get("edited-home").await.unwrap().unwrap();
        assert_eq!(preserved.pattern, edited.pattern);
        assert_eq!(preserved.priority, edited.priority);
        assert_eq!(preserved.preset_version, edited.preset_version);
        assert!(preserved.preset_modified);

        let repeated = svc.import_preset("fr", &resolver).await.unwrap();
        assert_eq!(repeated.added, 0);
        assert_eq!(repeated.updated, 0);
        assert_eq!(repeated.skipped_existing, preset.rules.len());
    }

    #[tokio::test]
    async fn preset_import_and_upgrade_keep_rule_activity_types() {
        let preset = presets::load_preset("it").unwrap();
        let mut groceries = mk_rule(
            "installed-groceries",
            "(?i)esselunga",
            "spending_categories",
            "groceries",
            80,
        );
        groceries.match_type = RuleMatchType::Regex;
        groceries.preset_id = Some("it".to_string());
        groceries.preset_rule_key = Some("it.food_groceries".to_string());
        groceries.preset_version = Some("0.0.0".to_string());

        let (svc, repo, _) = mk_svc(vec![groceries], vec![]);
        let result = svc.import_preset("it", &resolver_for("it")).await.unwrap();
        assert_eq!(result.added, preset.rules.len() - 1);
        assert_eq!(result.updated, 1);

        let activity_type_of = |key: &str| {
            let rules = repo.rules.lock().unwrap();
            rules
                .iter()
                .find(|rule| rule.preset_rule_key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("rule {key} should be installed"))
                .activity_type
                .clone()
        };
        assert_eq!(
            activity_type_of("it.food_groceries").as_deref(),
            Some("WITHDRAWAL")
        );
        assert_eq!(
            activity_type_of("it.income_salary").as_deref(),
            Some("DEPOSIT")
        );
        assert_eq!(activity_type_of("it.fees_bank"), None);

        let (svc, repo, _) = mk_svc(vec![], vec![]);
        svc.import_preset("fr", &resolver_for("fr")).await.unwrap();
        assert!(repo
            .rules
            .lock()
            .unwrap()
            .iter()
            .all(|rule| rule.activity_type.is_none()));
    }

    fn resolver_for(preset_id: &str) -> HashMap<String, (String, String)> {
        presets::load_preset(preset_id)
            .unwrap()
            .rules
            .iter()
            .map(|rule| {
                (
                    rule.category_key.clone(),
                    ("spending_categories".to_string(), rule.category_key.clone()),
                )
            })
            .collect()
    }

    fn dec(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    fn mk_svc(
        rules: Vec<CategorizationRule>,
        activities: Vec<Activity>,
    ) -> (
        CategorizationRulesService,
        Arc<MockRulesRepo>,
        Arc<MockAssignmentRepo>,
    ) {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(rules),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let activity_repo = Arc::new(MockActivityRepo {
            activities,
            assignments: vec![],
        });
        let svc = CategorizationRulesService::new(
            rules_repo.clone() as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            assignment_service,
        );
        (svc, rules_repo, assignment_repo)
    }

    fn base_new_rule() -> NewCategorizationRule {
        NewCategorizationRule {
            id: None,
            name: "amount rule".to_string(),
            pattern: "AMAZON".to_string(),
            match_type: RuleMatchType::Contains,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some("cat_food".to_string()),
            activity_type: None,
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            payee_condition_id: None,
            set_payee_id: None,
            priority: 1,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
        }
    }

    #[test]
    fn validate_rule_amount_matrix() {
        // Positive: every operator with a value; between inclusive of equal bounds; zero.
        for op in [
            RuleAmountOp::Eq,
            RuleAmountOp::Gt,
            RuleAmountOp::Gte,
            RuleAmountOp::Lt,
            RuleAmountOp::Lte,
        ] {
            assert!(validate_rule_amount(Some(op), Some(dec("10.50")), None).is_ok());
        }
        assert!(validate_rule_amount(
            Some(RuleAmountOp::Between),
            Some(dec("10")),
            Some(dec("20"))
        )
        .is_ok());
        assert!(validate_rule_amount(
            Some(RuleAmountOp::Between),
            Some(dec("10")),
            Some(dec("10"))
        )
        .is_ok());
        assert!(validate_rule_amount(Some(RuleAmountOp::Eq), Some(dec("0")), None).is_ok());
        assert!(validate_rule_amount(None, None, None).is_ok());

        // Negative: missing value, missing upper, swapped bounds, negative values.
        assert!(validate_rule_amount(Some(RuleAmountOp::Gt), None, None).is_err());
        assert!(validate_rule_amount(Some(RuleAmountOp::Between), Some(dec("10")), None).is_err());
        assert!(validate_rule_amount(
            Some(RuleAmountOp::Between),
            Some(dec("20")),
            Some(dec("10"))
        )
        .is_err());
        assert!(validate_rule_amount(Some(RuleAmountOp::Gt), Some(dec("-1")), None).is_err());
        assert!(
            validate_rule_amount(Some(RuleAmountOp::Between), Some(dec("1")), Some(dec("-2")))
                .is_err()
        );
    }

    #[tokio::test]
    async fn create_normalizes_amount_condition() {
        let (svc, _, _) = mk_svc(vec![], vec![]);

        // Values without an operator are dropped rather than stored.
        let mut no_op = base_new_rule();
        no_op.amount_value = Some(dec("50"));
        no_op.amount_value2 = Some(dec("60"));
        let created = svc.create(no_op).await.unwrap();
        assert_eq!(created.amount_op, None);
        assert_eq!(created.amount_value, None);
        assert_eq!(created.amount_value2, None);

        // A non-between operator drops the stale upper value.
        let mut gt = base_new_rule();
        gt.amount_op = Some(RuleAmountOp::Gt);
        gt.amount_value = Some(dec("100"));
        gt.amount_value2 = Some(dec("200"));
        let created = svc.create(gt).await.unwrap();
        assert_eq!(created.amount_op, Some(RuleAmountOp::Gt));
        assert_eq!(created.amount_value, Some(dec("100")));
        assert_eq!(created.amount_value2, None);
    }

    #[tokio::test]
    async fn create_rejects_invalid_amount_conditions() {
        let (svc, _, _) = mk_svc(vec![], vec![]);

        let mut missing_value = base_new_rule();
        missing_value.amount_op = Some(RuleAmountOp::Gte);
        let err = svc.create(missing_value).await.unwrap_err();
        assert!(err.to_string().contains("requires a value"));

        let mut swapped = base_new_rule();
        swapped.amount_op = Some(RuleAmountOp::Between);
        swapped.amount_value = Some(dec("55"));
        swapped.amount_value2 = Some(dec("45"));
        let err = svc.create(swapped).await.unwrap_err();
        assert!(err.to_string().contains("less than or equal"));

        let mut negative = base_new_rule();
        negative.amount_op = Some(RuleAmountOp::Lt);
        negative.amount_value = Some(dec("-5"));
        let err = svc.create(negative).await.unwrap_err();
        assert!(err.to_string().contains("cannot be negative"));
    }

    #[tokio::test]
    async fn update_clearing_op_clears_values() {
        let mut rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 1);
        rule.amount_op = Some(RuleAmountOp::Between);
        rule.amount_value = Some(dec("10"));
        rule.amount_value2 = Some(dec("20"));
        let (svc, _, _) = mk_svc(vec![rule], vec![]);

        let updated = svc
            .update(
                "r1",
                UpdateCategorizationRule {
                    amount_op: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.amount_op, None);
        assert_eq!(updated.amount_value, None);
        assert_eq!(updated.amount_value2, None);
    }

    #[tokio::test]
    async fn update_changing_op_from_between_drops_upper_value() {
        let mut rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 1);
        rule.amount_op = Some(RuleAmountOp::Between);
        rule.amount_value = Some(dec("10"));
        rule.amount_value2 = Some(dec("20"));
        let (svc, _, _) = mk_svc(vec![rule], vec![]);

        let updated = svc
            .update(
                "r1",
                UpdateCategorizationRule {
                    amount_op: Some(Some(RuleAmountOp::Gt)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.amount_op, Some(RuleAmountOp::Gt));
        assert_eq!(updated.amount_value, Some(dec("10")));
        assert_eq!(updated.amount_value2, None);
    }

    #[tokio::test]
    async fn update_rejects_swapped_between_bounds() {
        let mut rule = mk_rule("r1", "AMAZON", "spending_categories", "cat_food", 1);
        rule.amount_op = Some(RuleAmountOp::Between);
        rule.amount_value = Some(dec("10"));
        rule.amount_value2 = Some(dec("20"));
        let (svc, _, _) = mk_svc(vec![rule], vec![]);

        // Raising the lower value above the existing upper must be rejected.
        let err = svc
            .update(
                "r1",
                UpdateCategorizationRule {
                    amount_value: Some(Some(dec("100"))),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("less than or equal"));
    }

    fn mk_activity_amt(id: &str, account: &str, notes: &str, amount: &str) -> Activity {
        let mut a = mk_activity(id, account, notes);
        a.amount = Some(amount.parse().unwrap());
        a
    }

    #[tokio::test]
    async fn rerun_applies_amount_condition() {
        let mut rule = mk_rule("r1", "TRANSFER", "spending_categories", "cat_savings", 5);
        rule.amount_op = Some(RuleAmountOp::Gte);
        rule.amount_value = Some(dec("1000"));
        let (svc, _, assignment_repo) = mk_svc(
            vec![rule],
            vec![
                mk_activity_amt("small", "acct1", "TRANSFER TO SAVINGS", "50"),
                mk_activity_amt("large", "acct1", "TRANSFER TO SAVINGS", "1500"),
                // Signed amounts are compared unsigned.
                mk_activity_amt("negative", "acct1", "TRANSFER TO SAVINGS", "-2000"),
                // No amount at all: never matches an amount-conditioned rule.
                mk_activity("no_amount", "acct1", "TRANSFER TO SAVINGS"),
            ],
        );

        let matched = svc.rerun_all(&["acct1".to_string()], false).await.unwrap();
        assert_eq!(matched, 2);

        let writes = assignment_repo.writes.lock().unwrap();
        let mut written: Vec<&str> = writes.iter().map(|w| w.activity_id.as_str()).collect();
        written.sort();
        assert_eq!(written, vec!["large", "negative"]);
    }

    // ----- payee conditions and "also set payee" ---------------------------

    /// A service whose activities carry `existing` assignments, both on the
    /// rows the planner reads and in the writer that protects them.
    fn mk_payee_svc(
        rules: Vec<CategorizationRule>,
        activities: Vec<Activity>,
        existing: Vec<ActivityTaxonomyAssignment>,
    ) -> (
        CategorizationRulesService,
        Arc<MockRulesRepo>,
        Arc<MockAssignmentRepo>,
    ) {
        let rules_repo = Arc::new(MockRulesRepo {
            rules: Mutex::new(rules),
        });
        let assignment_repo = Arc::new(MockAssignmentRepo {
            existing: Mutex::new(existing.clone()),
            writes: Mutex::new(vec![]),
        });
        let activity_repo = Arc::new(MockActivityRepo {
            activities,
            assignments: existing,
        });
        let svc = CategorizationRulesService::new(
            rules_repo.clone() as Arc<dyn CategorizationRulesRepositoryTrait>,
            activity_repo as Arc<dyn CashActivityServiceTrait>,
            Arc::new(ActivityTaxonomyAssignmentService::new(
                assignment_repo.clone() as Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
            )),
        );
        (svc, rules_repo, assignment_repo)
    }

    /// A category rule that matches on a payee alone.
    fn mk_payee_condition_rule(
        id: &str,
        payee: &str,
        cat: &str,
        priority: i32,
    ) -> CategorizationRule {
        let mut rule = mk_rule(
            id,
            NO_TEXT_CONDITION_PATTERN,
            "spending_categories",
            cat,
            priority,
        );
        rule.match_type = RuleMatchType::Regex;
        rule.payee_condition_id = Some(payee.to_string());
        rule
    }

    /// The writes that went through, as sorted `(activity, taxonomy, category)`.
    fn applied(repo: &MockAssignmentRepo) -> Vec<(String, String, String)> {
        let mut writes: Vec<_> = repo
            .writes
            .lock()
            .unwrap()
            .iter()
            .map(|w| {
                (
                    w.activity_id.clone(),
                    w.taxonomy_id.clone(),
                    w.category_id.clone(),
                )
            })
            .collect();
        writes.sort();
        writes
    }

    fn row(a: &str, t: &str, c: &str) -> (String, String, String) {
        (a.to_string(), t.to_string(), c.to_string())
    }

    #[tokio::test]
    async fn a_payee_rule_feeds_a_payee_condition_rule_in_the_same_run() {
        let (svc, _, assignments) = mk_payee_svc(
            vec![
                mk_rule("payee", "AMZN", PAYEES_TAXONOMY, "payee_amazon", 0),
                mk_payee_condition_rule("category", "payee_amazon", "cat_shopping", 0),
            ],
            vec![
                mk_activity("amazon", "acct1", "AMZN MKTP 123"),
                mk_activity("other", "acct1", "CITY WATER"),
            ],
            vec![],
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(summary.matched, 1);
        assert_eq!(
            applied(&assignments),
            vec![
                row("amazon", PAYEES_TAXONOMY, "payee_amazon"),
                row("amazon", "spending_categories", "cat_shopping"),
            ]
        );
    }

    #[tokio::test]
    async fn a_manual_payee_drives_a_payee_condition_rule() {
        let (svc, _, assignments) = mk_payee_svc(
            vec![
                // The text says Netflix, the user said Amazon: the user's
                // payee stands and is what the category rule sees.
                mk_rule("payee", "NETFLIX", PAYEES_TAXONOMY, "payee_netflix", 0),
                mk_payee_condition_rule("amazon", "payee_amazon", "cat_shopping", 0),
                mk_payee_condition_rule("netflix", "payee_netflix", "cat_streaming", 0),
            ],
            vec![mk_activity("act", "acct1", "NETFLIX.COM")],
            vec![mk_assignment(
                "act",
                PAYEES_TAXONOMY,
                "payee_amazon",
                "manual",
            )],
        );

        svc.rerun_detailed(&["acct1".to_string()], false)
            .await
            .unwrap();
        assert_eq!(
            applied(&assignments),
            vec![row("act", "spending_categories", "cat_shopping")]
        );
    }

    #[tokio::test]
    async fn a_payee_condition_rule_leaves_a_manual_category_alone() {
        let (svc, _, assignments) = mk_payee_svc(
            vec![
                mk_rule("payee", "AMZN", PAYEES_TAXONOMY, "payee_amazon", 0),
                mk_payee_condition_rule("category", "payee_amazon", "cat_shopping", 0),
            ],
            vec![mk_activity("act", "acct1", "AMZN MKTP")],
            vec![mk_assignment(
                "act",
                "spending_categories",
                "cat_gifts",
                "manual",
            )],
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], false)
            .await
            .unwrap();
        assert_eq!(summary.matched, 1);
        // The payee is filed; the category the user chose is not replaced.
        assert_eq!(
            applied(&assignments),
            vec![row("act", PAYEES_TAXONOMY, "payee_amazon")]
        );
    }

    #[tokio::test]
    async fn an_existing_rule_payee_stands_unless_the_run_overwrites() {
        let rules = || {
            vec![
                mk_rule("payee", "AMZN", PAYEES_TAXONOMY, "payee_amazon", 0),
                mk_payee_condition_rule("amazon", "payee_amazon", "cat_shopping", 0),
                mk_payee_condition_rule("bakery", "payee_bakery", "cat_food", 0),
            ]
        };
        let existing = || {
            vec![mk_assignment(
                "act",
                PAYEES_TAXONOMY,
                "payee_bakery",
                "rule",
            )]
        };
        let activity = || vec![mk_activity("act", "acct1", "AMZN MKTP")];

        // Only-uncategorized: the payee an earlier run set is kept, so the
        // category follows it, not the payee this run would have set.
        let (svc, _, assignments) = mk_payee_svc(rules(), activity(), existing());
        svc.rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(
            applied(&assignments),
            vec![row("act", "spending_categories", "cat_food")]
        );

        // Overwriting: the payee is replaced and the category follows the new one.
        let (svc, _, assignments) = mk_payee_svc(rules(), activity(), existing());
        svc.rerun_detailed(&["acct1".to_string()], false)
            .await
            .unwrap();
        assert_eq!(
            applied(&assignments),
            vec![
                row("act", PAYEES_TAXONOMY, "payee_amazon"),
                row("act", "spending_categories", "cat_shopping"),
            ]
        );
    }

    #[tokio::test]
    async fn a_category_rule_also_sets_its_payee_and_respects_a_manual_one() {
        let mut rule = mk_rule("both", "AMZN", "spending_categories", "cat_shopping", 0);
        rule.set_payee_id = Some("payee_amazon".to_string());
        let (svc, _, assignments) = mk_payee_svc(
            vec![rule],
            vec![
                mk_activity("fresh", "acct1", "AMZN MKTP 1"),
                mk_activity("named", "acct1", "AMZN MKTP 2"),
            ],
            vec![mk_assignment(
                "named",
                PAYEES_TAXONOMY,
                "payee_bakery",
                "manual",
            )],
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], false)
            .await
            .unwrap();
        assert_eq!(summary.matched, 2);
        assert_eq!(
            applied(&assignments),
            vec![
                row("fresh", PAYEES_TAXONOMY, "payee_amazon"),
                row("fresh", "spending_categories", "cat_shopping"),
                // The user's payee is kept; the category is still set.
                row("named", "spending_categories", "cat_shopping"),
            ]
        );
    }

    #[tokio::test]
    async fn the_payee_a_category_rule_sets_feeds_payee_condition_rules() {
        let mut setter = mk_rule("setter", "AMZN", "spending_categories", "cat_shopping", 0);
        setter.set_payee_id = Some("payee_amazon".to_string());
        let (svc, _, assignments) = mk_payee_svc(
            vec![
                setter,
                // Same priority: the payee condition is the more specific rule.
                mk_payee_condition_rule("by-payee", "payee_amazon", "cat_gifts", 0),
            ],
            vec![mk_activity("act", "acct1", "AMZN MKTP")],
            vec![],
        );

        svc.rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(
            applied(&assignments),
            vec![
                row("act", PAYEES_TAXONOMY, "payee_amazon"),
                row("act", "spending_categories", "cat_gifts"),
            ]
        );
    }

    #[tokio::test]
    async fn a_payee_that_is_gone_is_neither_matched_nor_written() {
        let mut setter = mk_rule("setter", "AMZN", "spending_categories", "cat_shopping", 5);
        setter.set_payee_id = Some("payee_gone".to_string());
        let (svc, _, assignments) = mk_payee_svc(
            vec![
                setter,
                mk_payee_condition_rule("by-gone", "payee_gone", "cat_gifts", 10),
            ],
            vec![mk_activity("act", "acct1", "AMZN MKTP")],
            vec![],
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string()], true)
            .await
            .unwrap();
        assert_eq!(summary.matched, 1);
        // The category of the rule that matched on text is applied; the
        // missing payee is not written, and the rule conditioned on it stays
        // silent although it has the higher priority.
        assert_eq!(
            applied(&assignments),
            vec![row("act", "spending_categories", "cat_shopping")]
        );
    }

    #[tokio::test]
    async fn a_payee_only_rule_is_stored_with_the_placeholder_pattern() {
        let (svc, _, _) = mk_svc(vec![], vec![]);
        let mut new_rule = base_new_rule();
        new_rule.pattern = "  ".to_string();
        new_rule.match_type = RuleMatchType::Contains;
        new_rule.payee_condition_id = Some("payee_amazon".to_string());

        let created = svc.create(new_rule).await.unwrap();
        assert_eq!(created.match_type, RuleMatchType::Regex);
        assert_eq!(created.pattern, NO_TEXT_CONDITION_PATTERN);
        assert!(!created.has_text_condition());
        // What a version without payee conditions does with the stored rule:
        // it compiles the pattern, fails, and never matches.
        assert!(compile_regex_pattern(&created.pattern).is_err());

        // Giving it a text condition later stores the text as written.
        let updated = svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    pattern: Some("PRIME".to_string()),
                    match_type: Some(RuleMatchType::Contains),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.pattern, "PRIME");
        assert_eq!(updated.match_type, RuleMatchType::Contains);

        // Clearing the text again goes back to the placeholder.
        let cleared = svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    pattern: Some(String::new()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.match_type, RuleMatchType::Regex);
        assert_eq!(cleared.pattern, NO_TEXT_CONDITION_PATTERN);
    }

    #[tokio::test]
    async fn a_rule_with_no_condition_is_refused() {
        let (svc, _, _) = mk_svc(vec![], vec![]);

        let mut empty = base_new_rule();
        empty.pattern = String::new();
        let err = svc.create(empty.clone()).await.unwrap_err();
        assert!(err
            .to_string()
            .contains("text condition or a payee condition"));

        // The placeholder without a payee condition is no condition either,
        // wherever it comes from.
        let mut placeholder = base_new_rule();
        placeholder.pattern = NO_TEXT_CONDITION_PATTERN.to_string();
        placeholder.match_type = RuleMatchType::Regex;
        let err = svc.create(placeholder.clone()).await.unwrap_err();
        assert!(err
            .to_string()
            .contains("text condition or a payee condition"));
        placeholder.id = Some("placeholder".to_string());
        assert!(svc.upsert(placeholder).await.is_err());

        // Removing the payee condition of a payee-only rule leaves nothing.
        let mut payee_only = base_new_rule();
        payee_only.pattern = String::new();
        payee_only.payee_condition_id = Some("payee_amazon".to_string());
        let created = svc.create(payee_only).await.unwrap();
        let err = svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    payee_condition_id: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("text condition or a payee condition"));
        assert_eq!(
            svc.get(&created.id)
                .await
                .unwrap()
                .unwrap()
                .payee_condition_id
                .as_deref(),
            Some("payee_amazon")
        );
    }

    #[tokio::test]
    async fn a_rule_cannot_match_on_a_payee_and_set_one() {
        let (svc, _, _) = mk_svc(vec![], vec![]);

        let mut both = base_new_rule();
        both.payee_condition_id = Some("payee_amazon".to_string());
        both.set_payee_id = Some("payee_netflix".to_string());
        let err = svc.create(both).await.unwrap_err();
        assert!(err.to_string().contains("cannot set a payee"));

        let mut payee_target = base_new_rule();
        payee_target.taxonomy_id = Some(PAYEES_TAXONOMY.to_string());
        payee_target.category_id = Some("payee_netflix".to_string());
        payee_target.payee_condition_id = Some("payee_amazon".to_string());
        assert!(svc.create(payee_target.clone()).await.is_err());

        // "Also set payee" belongs to category rules only.
        payee_target.payee_condition_id = None;
        payee_target.set_payee_id = Some("payee_amazon".to_string());
        let err = svc.create(payee_target).await.unwrap_err();
        assert!(err.to_string().contains("sets a category"));
        let mut targetless = base_new_rule();
        targetless.taxonomy_id = None;
        targetless.category_id = None;
        targetless.set_payee_id = Some("payee_amazon".to_string());
        assert!(svc.create(targetless).await.is_err());

        // An update is checked against the rule it leaves behind.
        let mut setter = base_new_rule();
        setter.set_payee_id = Some("payee_amazon".to_string());
        let created = svc.create(setter).await.unwrap();
        assert!(svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    payee_condition_id: Some(Some("payee_netflix".to_string())),
                    ..Default::default()
                },
            )
            .await
            .is_err());
        assert!(svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    taxonomy_id: Some(Some(PAYEES_TAXONOMY.to_string())),
                    category_id: Some(Some("payee_netflix".to_string())),
                    ..Default::default()
                },
            )
            .await
            .is_err());
        // Swapping one for the other in a single patch is fine.
        let swapped = svc
            .update(
                &created.id,
                UpdateCategorizationRule {
                    payee_condition_id: Some(Some("payee_netflix".to_string())),
                    set_payee_id: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(swapped.payee_condition_id.as_deref(), Some("payee_netflix"));
        assert_eq!(swapped.set_payee_id, None);
    }

    #[tokio::test]
    async fn an_unknown_payee_is_refused_when_a_rule_starts_to_name_it() {
        let (svc, rules_repo, _) = mk_svc(vec![], vec![]);

        let mut unknown = base_new_rule();
        unknown.payee_condition_id = Some("payee_gone".to_string());
        let err = svc.create(unknown).await.unwrap_err();
        assert!(err.to_string().contains("Unknown payee"));
        let mut unknown = base_new_rule();
        unknown.set_payee_id = Some("payee_gone".to_string());
        assert!(svc.create(unknown).await.is_err());

        // A rule whose payee has since gone can still be edited.
        let mut stale = mk_payee_condition_rule("stale", "payee_gone", "cat_food", 0);
        stale.pattern = "AMZN".to_string();
        stale.match_type = RuleMatchType::Contains;
        rules_repo.rules.lock().unwrap().push(stale);
        let renamed = svc
            .update(
                "stale",
                UpdateCategorizationRule {
                    name: Some("renamed".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.payee_condition_id.as_deref(), Some("payee_gone"));
        // ...but not pointed at another payee that does not exist.
        assert!(svc
            .update(
                "stale",
                UpdateCategorizationRule {
                    payee_condition_id: Some(Some("payee_also_gone".to_string())),
                    ..Default::default()
                },
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_reviewed_edit_carries_the_payee_fields() {
        let mut existing = mk_rule("r", "AMZN", "spending_categories", "cat_shopping", 0);
        existing.payee_condition_id = Some("payee_amazon".to_string());
        let (svc, _, _) = mk_svc(vec![existing.clone()], vec![]);

        // The proposal an assistant edit builds: the stored rule with one
        // field changed. The payee condition must come out the other side.
        let mut proposed: NewCategorizationRule =
            serde_json::from_value(serde_json::to_value(&existing).unwrap()).unwrap();
        proposed.name = "renamed".to_string();
        let updated = svc.update_reviewed(existing, proposed).await.unwrap();
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.payee_condition_id.as_deref(), Some("payee_amazon"));
        assert_eq!(updated.pattern, "AMZN");
    }

    // ----- rules saved by earlier versions, addon upserts, partial patches --

    #[tokio::test]
    async fn a_legacy_empty_pattern_rule_still_matches_its_scope() {
        let mut catch_all = mk_rule("catch-all", "", "spending_categories", "cat_misc", 0);
        catch_all.account_id = Some("acct1".to_string());
        catch_all.is_global = false;
        let (svc, _, assignments) = mk_payee_svc(
            vec![catch_all],
            vec![
                mk_activity("in-scope", "acct1", "ANYTHING"),
                mk_activity("no-notes", "acct1", ""),
                mk_activity("other-account", "acct2", "ANYTHING"),
            ],
            vec![],
        );

        let summary = svc
            .rerun_detailed(&["acct1".to_string(), "acct2".to_string()], true)
            .await
            .unwrap();
        assert_eq!(summary.matched, 2);
        assert_eq!(
            applied(&assignments),
            vec![
                row("in-scope", "spending_categories", "cat_misc"),
                row("no-notes", "spending_categories", "cat_misc"),
            ]
        );
    }

    #[tokio::test]
    async fn a_legacy_empty_pattern_rule_can_still_be_edited() {
        let legacy = mk_rule("legacy", "", "spending_categories", "cat_misc", 0);
        let (svc, _, _) = mk_svc(vec![legacy.clone()], vec![]);

        let renamed = svc
            .update(
                "legacy",
                UpdateCategorizationRule {
                    name: Some("Everything else".to_string()),
                    priority: Some(3),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.name, "Everything else");
        assert_eq!(renamed.priority, 3);
        assert_eq!(renamed.pattern, "");
        assert_eq!(renamed.match_type, RuleMatchType::Contains);

        // The form sends the pattern with every save: the same empty one.
        let saved = svc
            .update(
                "legacy",
                UpdateCategorizationRule {
                    pattern: Some(String::new()),
                    match_type: Some(RuleMatchType::Contains),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(saved.pattern, "");

        // An upsert keeps it valid too, as earlier versions did.
        let mut upserted: NewCategorizationRule =
            serde_json::from_value(serde_json::to_value(&saved).unwrap()).unwrap();
        upserted.priority = 4;
        assert_eq!(svc.upsert(upserted).await.unwrap().priority, 4);

        // A reviewed edit of it, likewise.
        let current = svc.get("legacy").await.unwrap().unwrap();
        let mut proposed: NewCategorizationRule =
            serde_json::from_value(serde_json::to_value(&current).unwrap()).unwrap();
        proposed.name = "Catch-all".to_string();
        assert_eq!(
            svc.update_reviewed(current, proposed).await.unwrap().name,
            "Catch-all"
        );
    }

    #[tokio::test]
    async fn a_patch_cannot_newly_empty_a_rules_pattern() {
        let (svc, _, _) = mk_svc(
            vec![mk_rule(
                "text",
                "AMZN",
                "spending_categories",
                "cat_misc",
                0,
            )],
            vec![],
        );
        let err = svc
            .update(
                "text",
                UpdateCategorizationRule {
                    pattern: Some("  ".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err
            .to_string()
            .contains("text condition or a payee condition"));
        assert_eq!(svc.get("text").await.unwrap().unwrap().pattern, "AMZN");
    }

    #[tokio::test]
    async fn a_patch_of_a_payee_only_rule_reads_its_text_as_new() {
        let (svc, _, _) = mk_svc(
            vec![mk_payee_condition_rule(
                "by-payee",
                "payee_amazon",
                "cat_shopping",
                0,
            )],
            vec![],
        );

        // A match type alone gives it no text: it stays payee-only.
        let typed = svc
            .update(
                "by-payee",
                UpdateCategorizationRule {
                    match_type: Some(RuleMatchType::Contains),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(typed.match_type, RuleMatchType::Regex);
        assert_eq!(typed.pattern, NO_TEXT_CONDITION_PATTERN);

        // A text alone is matched as `contains`, not as the placeholder's regex.
        let texted = svc
            .update(
                "by-payee",
                UpdateCategorizationRule {
                    pattern: Some("Prime".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(texted.match_type, RuleMatchType::Contains);
        assert_eq!(texted.pattern, "Prime");
        assert_eq!(texted.payee_condition_id.as_deref(), Some("payee_amazon"));
    }

    #[tokio::test]
    async fn an_addon_upsert_keeps_the_payee_fields_the_user_added() {
        let mut stored = mk_payee_condition_rule("addon:x:r", "payee_amazon", "cat_shopping", 0);
        stored.name = "Addon rule".to_string();
        let mut setter = mk_rule("addon:x:s", "BAKERY", "spending_categories", "cat_food", 0);
        setter.set_payee_id = Some("payee_bakery".to_string());
        let (svc, _, _) = mk_svc(vec![stored, setter], vec![]);

        // What the addon bridge sends: no payee fields at all.
        let addon_rule = |id: &str, pattern: &str, category: &str| NewCategorizationRule {
            id: Some(id.to_string()),
            pattern: pattern.to_string(),
            category_id: Some(category.to_string()),
            ..base_new_rule()
        };

        // The addon's text joins the payee condition: narrower, never wider.
        let narrowed = svc
            .upsert(addon_rule("addon:x:r", "PRIME", "cat_shopping"))
            .await
            .unwrap();
        assert_eq!(narrowed.payee_condition_id.as_deref(), Some("payee_amazon"));
        assert_eq!(narrowed.pattern, "PRIME");
        assert_eq!(narrowed.match_type, RuleMatchType::Contains);

        // An empty addon text leaves it payee-only.
        let payee_only = svc
            .upsert(addon_rule("addon:x:r", "", "cat_shopping"))
            .await
            .unwrap();
        assert_eq!(
            payee_only.payee_condition_id.as_deref(),
            Some("payee_amazon")
        );
        assert_eq!(payee_only.pattern, NO_TEXT_CONDITION_PATTERN);

        let kept = svc
            .upsert(addon_rule("addon:x:s", "BAKERY CO", "cat_food"))
            .await
            .unwrap();
        assert_eq!(kept.set_payee_id.as_deref(), Some("payee_bakery"));
        assert_eq!(kept.pattern, "BAKERY CO");

        // An upsert that names a payee field replaces both.
        let mut named = addon_rule("addon:x:s", "BAKERY CO", "cat_food");
        named.set_payee_id = Some("payee_netflix".to_string());
        let replaced = svc.upsert(named).await.unwrap();
        assert_eq!(replaced.set_payee_id.as_deref(), Some("payee_netflix"));
        assert_eq!(replaced.payee_condition_id, None);
    }
}
