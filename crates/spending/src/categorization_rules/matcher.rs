//! Rule-matching algorithm. Ported semantics from PR #494's category_rules matcher.

use regex::{Regex, RegexBuilder};
use rust_decimal::Decimal;

use super::model::{CategorizationRule, RuleAmountOp, RuleMatchType};

#[derive(Debug, Clone)]
pub struct RuleMatch<'r> {
    pub rule: &'r CategorizationRule,
}

/// A `CategorizationRule` with its pattern pre-normalized (uppercase for the
/// non-regex variants, compiled `Regex` for the regex variant). Built once
/// per rerun via [`compile_rules`] so the per-activity loop avoids
/// re-normalizing strings and re-compiling regex on every comparison.
pub struct CompiledRule<'r> {
    pub rule: &'r CategorizationRule,
    pattern_upper: String,
    regex: Option<Regex>,
    has_text_condition: bool,
}

/// What a rule is matched against: one activity, as the rule run sees it.
#[derive(Debug, Clone, Copy)]
pub struct RuleInput<'a> {
    /// The notes in upper case, for the case-insensitive match types.
    pub notes_upper: &'a str,
    /// The notes as written: a regex matches the original casing.
    pub notes_raw: &'a str,
    pub activity_type: &'a str,
    pub account_id: &'a str,
    /// The activity's unsigned amount (`activity.amount.map(|d| d.abs())`).
    /// An activity without an amount never matches a rule that has an amount
    /// condition.
    pub amount: Option<Decimal>,
    /// The payee the activity is filed under once the payee rules have run,
    /// for rules with a payee condition. `None` matches none of them.
    pub payee_id: Option<&'a str>,
}

pub const MAX_REGEX_PATTERN_LEN: usize = 512;
const REGEX_SIZE_LIMIT_BYTES: usize = 64 * 1024;

pub fn compile_regex_pattern(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT_BYTES)
        .build()
}

/// Precompile a slice of rules: uppercase their patterns and compile regex
/// patterns. Rules whose regex fails to compile are kept with `regex = None`
/// so they will simply never match (matches the previous
/// `Regex::new(...).ok()` fall-through).
pub fn compile_rules(rules: &[CategorizationRule]) -> Vec<CompiledRule<'_>> {
    rules
        .iter()
        .map(|rule| {
            let has_text_condition = rule.has_text_condition();
            let regex = if has_text_condition && matches!(rule.match_type, RuleMatchType::Regex) {
                match compile_regex_pattern(&rule.pattern) {
                    Ok(re) => Some(re),
                    Err(err) => {
                        log::debug!("Categorization rule {} has invalid regex: {}", rule.id, err);
                        None
                    }
                }
            } else {
                None
            };
            CompiledRule {
                rule,
                pattern_upper: rule.pattern.to_uppercase(),
                regex,
                has_text_condition,
            }
        })
        .collect()
}

/// How narrowly a rule matches, to choose between rules of equal priority: a
/// rule that names a payee beats one that names an exact text, which beats a
/// prefix, which beats a fragment or a regex. It is derived from the rule each
/// time and stored nowhere; rules of equal priority and specificity keep the
/// order they are listed in (oldest first).
fn specificity(rule: &CategorizationRule) -> u8 {
    if rule.payee_condition_id.is_some() {
        return 3;
    }
    match rule.match_type {
        RuleMatchType::Exact => 2,
        RuleMatchType::StartsWith => 1,
        RuleMatchType::Contains | RuleMatchType::Regex => 0,
    }
}

/// The best match in a precompiled rule set: the highest priority, then the
/// most specific rule (see [`specificity`]), then the first listed. Callers
/// that loop over many activities should normalize each activity's notes to
/// uppercase once.
///
/// A rule with a payee condition matches only an activity filed under that
/// payee. A rule without a text condition matches on its payee condition
/// alone; with neither it never matches.
pub fn match_compiled<'c, 'r: 'c>(
    compiled: impl IntoIterator<Item = &'c CompiledRule<'r>>,
    input: &RuleInput<'_>,
) -> Option<RuleMatch<'r>> {
    let mut best: Option<&CategorizationRule> = None;

    for c in compiled {
        let rule = c.rule;

        if !rule.is_global {
            match &rule.account_id {
                Some(rule_acc) if rule_acc == input.account_id => {}
                _ => continue,
            }
        }

        if let Some(rt) = &rule.activity_type {
            if rt != input.activity_type {
                continue;
            }
        }

        if let Some(op) = rule.amount_op {
            let (Some(amt), Some(value)) = (input.amount, rule.amount_value) else {
                continue;
            };
            let amount_matched = match op {
                RuleAmountOp::Eq => amt == value,
                RuleAmountOp::Gt => amt > value,
                RuleAmountOp::Gte => amt >= value,
                RuleAmountOp::Lt => amt < value,
                RuleAmountOp::Lte => amt <= value,
                RuleAmountOp::Between => rule
                    .amount_value2
                    .is_some_and(|upper| amt >= value && amt <= upper),
            };
            if !amount_matched {
                continue;
            }
        }

        if let Some(payee) = rule.payee_condition_id.as_deref() {
            if input.payee_id != Some(payee) {
                continue;
            }
        }

        let matched = if c.has_text_condition {
            match rule.match_type {
                RuleMatchType::Contains => input.notes_upper.contains(&c.pattern_upper),
                RuleMatchType::StartsWith => input.notes_upper.starts_with(&c.pattern_upper),
                RuleMatchType::Exact => input.notes_upper == c.pattern_upper,
                RuleMatchType::Regex => c
                    .regex
                    .as_ref()
                    .is_some_and(|re| re.is_match(input.notes_raw)),
            }
        } else {
            rule.payee_condition_id.is_some()
        };

        if !matched {
            continue;
        }

        match best {
            None => best = Some(rule),
            Some(current)
                if (rule.priority, specificity(rule))
                    > (current.priority, specificity(current)) =>
            {
                best = Some(rule)
            }
            _ => {}
        }
    }

    best.map(|rule| RuleMatch { rule })
}

/// Select priority within the activity's cash-flow taxonomy. A rule that cannot
/// apply must not hide a compatible rule. Targetless rules retain their existing
/// priority so callers can continue reporting matches without a category target.
pub fn match_compiled_for_taxonomy<'c, 'r: 'c>(
    compiled: impl IntoIterator<Item = &'c CompiledRule<'r>>,
    taxonomy_id: Option<&str>,
    input: &RuleInput<'_>,
) -> Option<RuleMatch<'r>> {
    match_compiled(
        compiled.into_iter().filter(|candidate| {
            candidate.rule.category_id.is_none()
                || candidate.rule.taxonomy_id.is_none()
                || candidate.rule.taxonomy_id.as_deref() == taxonomy_id
        }),
        input,
    )
}

/// The two passes of a rule run over one compiled rule set.
///
/// A payee sits beside the category instead of competing with it, so payees
/// are matched in a pass of their own: one activity can take its category
/// from one rule and its payee from another. The payee pass comes first, so
/// that the category pass can match on the payee it leaves (see
/// [`effective_payee`]).
pub struct RulePasses<'c, 'r> {
    payee_setters: Vec<&'c CompiledRule<'r>>,
    category_rules: Vec<&'c CompiledRule<'r>>,
}

impl<'c, 'r> RulePasses<'c, 'r> {
    /// `known_payees` are the payees that exist. A rule can name one that is
    /// gone: the payee columns have no foreign key, and a peer can delete a
    /// payee another peer's rule uses. Such a rule sets no payee, and a rule
    /// conditioned on it matches nothing. Payee targets are held by a foreign
    /// key, so when no rule uses the other columns `None` skips the lookup.
    pub fn new(
        compiled: &'c [CompiledRule<'r>],
        known_payees: Option<&std::collections::HashSet<String>>,
    ) -> Self {
        let is_known = |payee_id: &str| known_payees.is_none_or(|known| known.contains(payee_id));
        Self {
            payee_setters: compiled
                .iter()
                .filter(|c| c.rule.payee_to_set().is_some_and(is_known))
                .collect(),
            category_rules: compiled
                .iter()
                .filter(|c| {
                    c.rule.taxonomy_id.as_deref()
                        != Some(crate::activity_assignments::PAYEES_TAXONOMY)
                })
                .filter(|c| c.rule.payee_condition_id.as_deref().is_none_or(is_known))
                .collect(),
        }
    }

    /// Whether any of `rules` names a payee outside its target, so that a run
    /// over them has to know which payees exist.
    pub fn needs_known_payees(rules: &[CategorizationRule]) -> bool {
        rules
            .iter()
            .any(|r| r.payee_condition_id.is_some() || r.set_payee_id.is_some())
    }

    /// The payee the rules file the activity under: the target of the best
    /// matching payee rule, or the payee the best matching category rule also
    /// sets, whichever of them ranks first. `input.payee_id` is not read: no
    /// rule that sets a payee can match on one.
    pub fn planned_payee(&self, input: &RuleInput<'_>) -> Option<&'r str> {
        self.payee_setter(input)
            .and_then(|rule| rule.payee_to_set())
    }

    /// The rule [`Self::planned_payee`] takes the payee from.
    pub fn payee_setter(&self, input: &RuleInput<'_>) -> Option<&'r CategorizationRule> {
        let input = RuleInput {
            payee_id: None,
            ..*input
        };
        match_compiled(self.payee_setters.iter().copied(), &input).map(|m| m.rule)
    }

    /// The rules of the category pass: every rule but the payee rules.
    pub fn category_rules(&self) -> impl Iterator<Item = &'c CompiledRule<'r>> + '_ {
        self.category_rules.iter().copied()
    }
}

/// The payee an activity is filed under once a rule run has written its
/// payees: what rules with a payee condition are matched against.
///
/// The run leaves a payee the user set alone, and in the only-uncategorized
/// mode any payee the activity already has, so those stand. Otherwise the
/// payee this run's rules set (`planned`) takes its place, and without one the
/// existing payee stays.
pub fn effective_payee<'a>(
    assignments: &'a [crate::activity_assignments::ActivityTaxonomyAssignment],
    planned: Option<&'a str>,
    only_uncategorized: bool,
) -> Option<&'a str> {
    let mut existing = assignments
        .iter()
        .filter(|a| a.taxonomy_id == crate::activity_assignments::PAYEES_TAXONOMY);
    let manual = existing
        .clone()
        .find(|a| a.source.eq_ignore_ascii_case("manual"));
    let kept = manual.or_else(|| existing.next());
    match (kept, planned) {
        (Some(kept), Some(planned)) => {
            if manual.is_some() || only_uncategorized {
                Some(kept.category_id.as_str())
            } else {
                Some(planned)
            }
        }
        (Some(kept), None) => Some(kept.category_id.as_str()),
        (None, planned) => planned,
    }
}

/// Single-shot match against an un-compiled rule slice, for an activity
/// without a payee. Convenience for the rule-tester / single-activity paths
/// where the per-call compile cost is negligible. Bulk paths should use
/// [`compile_rules`] + [`match_compiled`].
pub fn match_rules<'r>(
    rules: &'r [CategorizationRule],
    notes: &str,
    activity_type: &str,
    account_id: &str,
    amount: Option<Decimal>,
) -> Option<RuleMatch<'r>> {
    let compiled = compile_rules(rules);
    let notes_upper = notes.to_uppercase();
    match_compiled(
        &compiled,
        &RuleInput {
            notes_upper: &notes_upper,
            notes_raw: notes,
            activity_type,
            account_id,
            amount: amount.map(|d| d.abs()),
            payee_id: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn rule(name: &str, pattern: &str, mt: RuleMatchType, prio: i32) -> CategorizationRule {
        CategorizationRule {
            id: name.to_string(),
            name: name.to_string(),
            pattern: pattern.to_string(),
            match_type: mt,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some("cat_food".to_string()),
            activity_type: None,
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            payee_condition_id: None,
            set_payee_id: None,
            priority: prio,
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

    fn amount_rule(
        name: &str,
        op: RuleAmountOp,
        value: &str,
        value2: Option<&str>,
        prio: i32,
    ) -> CategorizationRule {
        let mut r = rule(name, "FOO", RuleMatchType::Contains, prio);
        r.amount_op = Some(op);
        r.amount_value = Some(value.parse().unwrap());
        r.amount_value2 = value2.map(|v| v.parse().unwrap());
        r
    }

    fn dec(s: &str) -> Option<Decimal> {
        Some(s.parse().unwrap())
    }

    fn input<'a>(
        notes_upper: &'a str,
        notes_raw: &'a str,
        payee: Option<&'a str>,
    ) -> RuleInput<'a> {
        RuleInput {
            notes_upper,
            notes_raw,
            activity_type: "WITHDRAWAL",
            account_id: "acct1",
            amount: None,
            payee_id: payee,
        }
    }

    fn payee_rule(name: &str, payee: &str, prio: i32) -> CategorizationRule {
        let mut r = rule(
            name,
            crate::categorization_rules::model::NO_TEXT_CONDITION_PATTERN,
            RuleMatchType::Regex,
            prio,
        );
        r.payee_condition_id = Some(payee.to_string());
        r
    }

    fn matched(rules: &[CategorizationRule], notes: &str, payee: Option<&str>) -> Option<String> {
        let compiled = compile_rules(rules);
        let upper = notes.to_uppercase();
        match_compiled(&compiled, &input(&upper, notes, payee)).map(|m| m.rule.id.clone())
    }

    #[test]
    fn the_no_text_placeholder_is_not_a_regex_an_older_version_can_compile() {
        // An older version compiles the stored pattern as a regex and, when
        // that fails, never matches the rule. It must keep failing.
        assert!(compile_regex_pattern(
            crate::categorization_rules::model::NO_TEXT_CONDITION_PATTERN
        )
        .is_err());
    }

    #[test]
    fn a_payee_only_rule_never_matches_a_matcher_that_ignores_its_payee_condition() {
        // What an older version sees of a payee-only rule: a regex rule whose
        // pattern does not compile. Stored as `contains ""` it would match
        // every activity there.
        let mut as_older_version_sees_it = payee_rule("payee-only", "payee-amazon", 0);
        as_older_version_sees_it.payee_condition_id = None;
        assert_eq!(
            matched(&[as_older_version_sees_it], "ANYTHING AT ALL", None),
            None
        );
    }

    #[test]
    fn a_payee_only_rule_matches_its_payee_whatever_the_text() {
        let rules = vec![payee_rule("amazon", "payee-amazon", 0)];
        assert_eq!(
            matched(&rules, "whatever", Some("payee-amazon")),
            Some("amazon".to_string())
        );
        assert_eq!(
            matched(&rules, "", Some("payee-amazon")),
            Some("amazon".to_string())
        );
        assert_eq!(matched(&rules, "whatever", Some("payee-other")), None);
        assert_eq!(matched(&rules, "whatever", None), None);
    }

    #[test]
    fn a_payee_condition_is_anded_with_the_text_condition() {
        let mut r = rule("both", "PRIME", RuleMatchType::Contains, 0);
        r.payee_condition_id = Some("payee-amazon".to_string());
        let rules = vec![r];
        assert_eq!(
            matched(&rules, "prime video", Some("payee-amazon")),
            Some("both".to_string())
        );
        assert_eq!(matched(&rules, "books", Some("payee-amazon")), None);
        assert_eq!(matched(&rules, "prime video", Some("payee-other")), None);
        assert_eq!(matched(&rules, "prime video", None), None);
    }

    #[test]
    fn the_placeholder_without_a_payee_condition_never_matches() {
        // Neither text nor payee: the placeholder alone is no condition, not
        // "everything".
        let rules = vec![rule(
            "empty",
            crate::categorization_rules::model::NO_TEXT_CONDITION_PATTERN,
            RuleMatchType::Regex,
            0,
        )];
        assert_eq!(matched(&rules, "anything", Some("payee-amazon")), None);
        assert_eq!(matched(&rules, "", None), None);
    }

    #[test]
    fn a_legacy_empty_pattern_still_matches_everything_in_its_scope() {
        // Earlier versions saved catch-all rules (one account, one activity
        // type) with an empty pattern. They keep their meaning.
        let mut catch_all = rule("catch-all", "", RuleMatchType::Contains, 0);
        catch_all.activity_type = Some("WITHDRAWAL".to_string());
        let starts = rule("starts", "  ", RuleMatchType::StartsWith, 0);
        assert_eq!(
            matched(std::slice::from_ref(&catch_all), "anything", None),
            Some("catch-all".to_string())
        );
        assert_eq!(
            matched(std::slice::from_ref(&catch_all), "", None),
            Some("catch-all".to_string())
        );
        catch_all.activity_type = Some("DEPOSIT".to_string());
        assert_eq!(matched(&[catch_all], "anything", None), None);
        // Blank text is matched as written, like any other text.
        assert_eq!(
            matched(std::slice::from_ref(&starts), "anything", None),
            None
        );
        assert_eq!(
            matched(&[starts], "  anything", None),
            Some("starts".to_string())
        );
    }

    #[test]
    fn equal_priority_prefers_the_more_specific_rule() {
        let mut contains = rule("contains", "FOO", RuleMatchType::Contains, 1);
        let mut regex = rule("regex", "(?i)foo", RuleMatchType::Regex, 1);
        let mut starts = rule("starts", "FOO", RuleMatchType::StartsWith, 1);
        let mut exact = rule("exact", "FOO", RuleMatchType::Exact, 1);
        let mut payee = payee_rule("payee", "payee-foo", 1);
        // Listed least specific first, as the oldest rules would be.
        let base = Utc::now().naive_utc();
        for (i, r) in [
            &mut contains,
            &mut regex,
            &mut starts,
            &mut exact,
            &mut payee,
        ]
        .into_iter()
        .enumerate()
        {
            r.created_at = base + chrono::Duration::seconds(i as i64);
        }

        let all = vec![
            contains.clone(),
            regex.clone(),
            starts.clone(),
            exact.clone(),
            payee,
        ];
        assert_eq!(
            matched(&all, "foo", Some("payee-foo")),
            Some("payee".to_string())
        );
        assert_eq!(matched(&all, "foo", None), Some("exact".to_string()));
        assert_eq!(matched(&all, "foo bar", None), Some("starts".to_string()));
        // A fragment and a regex are equally specific: the first listed wins.
        assert_eq!(matched(&all, "a foo", None), Some("contains".to_string()));
        assert_eq!(
            matched(&[regex.clone(), contains.clone()], "a foo", None),
            Some("regex".to_string())
        );
        // Priority still comes first.
        contains.priority = 2;
        assert_eq!(
            matched(&[contains, exact], "foo", None),
            Some("contains".to_string())
        );
    }

    /// The rule form stores a "matches any of" list as a regex (see
    /// `apps/frontend/src/features/spending/lib/rule-conditions.ts`). These
    /// are the strings its tests expect it to produce: they must compile
    /// here, and match as the list reads.
    #[test]
    fn a_list_the_rule_form_compiles_matches_as_the_list_reads() {
        let any_of = |pattern: &str| vec![rule("list", pattern, RuleMatchType::Regex, 0)];

        let contains = any_of(r"(?i)(?:AT\&T|Disney\+|A\|B|C\.O\.D\. \(x\))");
        for notes in ["pos at&t wireless", "DISNEY+ 123", "a|b", "c.o.d. (x)"] {
            assert!(matched(&contains, notes, None).is_some(), "{notes}");
        }
        for notes in ["disneyy", "ATT", "ab", "cxoxdx (x)"] {
            assert!(matched(&contains, notes, None).is_none(), "{notes}");
        }

        let exact = any_of(r"(?i)^(?:NETFLIX|SPOTIFY)$");
        assert!(matched(&exact, "netflix", None).is_some());
        assert!(matched(&exact, "Spotify", None).is_some());
        assert!(matched(&exact, "NETFLIX.COM", None).is_none());
        assert!(matched(&exact, "MY NETFLIX", None).is_none());

        // Every character the form escapes is a valid escape here.
        let every_meta = any_of(r"(?i)(?:\\\.\+\*\?\(\)\|\[\]\{\}\^\$\#\&\-\~)");
        assert!(matched(&every_meta, r"x \.+*?()|[]{}^$#&-~ y", None).is_some());
    }

    fn payee_assignment(
        payee: &str,
        source: &str,
    ) -> crate::activity_assignments::ActivityTaxonomyAssignment {
        crate::activity_assignments::ActivityTaxonomyAssignment {
            id: format!("assignment-{payee}"),
            activity_id: "activity".to_string(),
            taxonomy_id: crate::activity_assignments::PAYEES_TAXONOMY.to_string(),
            category_id: payee.to_string(),
            weight: 10_000,
            source: source.to_string(),
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
        }
    }

    #[test]
    fn the_effective_payee_is_the_one_the_run_leaves_on_the_activity() {
        let none = [];
        let manual = [payee_assignment("manual", "manual")];
        let by_rule = [payee_assignment("old", "rule")];

        assert_eq!(effective_payee(&none, None, true), None);
        assert_eq!(effective_payee(&none, Some("new"), true), Some("new"));
        // A manual payee is never replaced.
        assert_eq!(effective_payee(&manual, Some("new"), true), Some("manual"));
        assert_eq!(effective_payee(&manual, Some("new"), false), Some("manual"));
        // A payee a rule set is replaced only when the run overwrites.
        assert_eq!(effective_payee(&by_rule, Some("new"), true), Some("old"));
        assert_eq!(effective_payee(&by_rule, Some("new"), false), Some("new"));
        assert_eq!(effective_payee(&by_rule, None, false), Some("old"));
    }

    #[test]
    fn contains_matches_case_insensitive() {
        let rules = vec![rule("amazon", "AMAZON", RuleMatchType::Contains, 0)];
        let m = match_rules(&rules, "amazon order #123", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "amazon");
    }

    #[test]
    fn higher_priority_wins() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("b", "FOO", RuleMatchType::Contains, 5),
        ];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", None).unwrap();
        assert_eq!(m.rule.id, "b");
    }

    #[test]
    fn account_scoped_rule_skipped_for_other_account() {
        let mut r = rule("scoped", "FOO", RuleMatchType::Contains, 10);
        r.is_global = false;
        r.account_id = Some("acct-other".to_string());
        let rules = vec![r];
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", None);
        assert!(m.is_none());
    }

    #[test]
    fn compiled_matches_same_as_uncompiled() {
        let rules = vec![
            rule("a", "FOO", RuleMatchType::Contains, 1),
            rule("re", r"^bar.*", RuleMatchType::Regex, 2),
        ];
        let compiled = compile_rules(&rules);

        let m = match_compiled(&compiled, &input("FOO X", "FOO X", None)).unwrap();
        assert_eq!(m.rule.id, "a");
        let m = match_compiled(&compiled, &input("BARABC", "barabc", None)).unwrap();
        assert_eq!(m.rule.id, "re");
    }

    #[test]
    fn regex_matches_remain_case_sensitive_by_default() {
        let rules = vec![rule("re", r"^Coffee$", RuleMatchType::Regex, 1)];

        assert!(match_rules(&rules, "Coffee", "WITHDRAWAL", "acct1", None).is_some());
        assert!(match_rules(&rules, "COFFEE", "WITHDRAWAL", "acct1", None).is_none());
    }

    #[test]
    fn invalid_regex_never_matches_but_doesnt_crash() {
        let rules = vec![rule("bad", "(unclosed", RuleMatchType::Regex, 5)];
        let compiled = compile_rules(&rules);
        let m = match_compiled(&compiled, &input("ANYTHING", "anything", None));
        assert!(m.is_none());
    }

    fn matches_amount(r: &CategorizationRule, amount: Option<Decimal>) -> bool {
        let rules = std::slice::from_ref(r);
        match_rules(rules, "FOO BAR", "WITHDRAWAL", "acct1", amount).is_some()
    }

    #[test]
    fn amount_eq_matches_exact_value_only() {
        let r = amount_rule("eq", RuleAmountOp::Eq, "10.50", None, 0);
        assert!(matches_amount(&r, dec("10.50")));
        assert!(matches_amount(&r, dec("10.5")));
        assert!(!matches_amount(&r, dec("10.49")));
        assert!(!matches_amount(&r, dec("10.51")));
    }

    #[test]
    fn amount_gt_is_strict_gte_is_inclusive() {
        let gt = amount_rule("gt", RuleAmountOp::Gt, "100", None, 0);
        assert!(matches_amount(&gt, dec("100.01")));
        assert!(!matches_amount(&gt, dec("100")));
        assert!(!matches_amount(&gt, dec("99.99")));

        let gte = amount_rule("gte", RuleAmountOp::Gte, "100", None, 0);
        assert!(matches_amount(&gte, dec("100")));
        assert!(matches_amount(&gte, dec("100.01")));
        assert!(!matches_amount(&gte, dec("99.99")));
    }

    #[test]
    fn amount_lt_is_strict_lte_is_inclusive() {
        let lt = amount_rule("lt", RuleAmountOp::Lt, "100", None, 0);
        assert!(matches_amount(&lt, dec("99.99")));
        assert!(!matches_amount(&lt, dec("100")));
        assert!(!matches_amount(&lt, dec("100.01")));

        let lte = amount_rule("lte", RuleAmountOp::Lte, "100", None, 0);
        assert!(matches_amount(&lte, dec("100")));
        assert!(matches_amount(&lte, dec("99.99")));
        assert!(!matches_amount(&lte, dec("100.01")));
    }

    #[test]
    fn amount_between_is_inclusive_both_ends() {
        let r = amount_rule("between", RuleAmountOp::Between, "45", Some("55"), 0);
        assert!(matches_amount(&r, dec("45")));
        assert!(matches_amount(&r, dec("50")));
        assert!(matches_amount(&r, dec("55")));
        assert!(!matches_amount(&r, dec("44.99")));
        assert!(!matches_amount(&r, dec("55.01")));
    }

    #[test]
    fn amount_zero_compares_normally() {
        let eq = amount_rule("eq0", RuleAmountOp::Eq, "0", None, 0);
        assert!(matches_amount(&eq, dec("0")));
        let lte = amount_rule("lte0", RuleAmountOp::Lte, "0", None, 0);
        assert!(matches_amount(&lte, dec("0")));
    }

    #[test]
    fn missing_activity_amount_never_matches_amount_rule() {
        let r = amount_rule("gt", RuleAmountOp::Gt, "0", None, 0);
        assert!(!matches_amount(&r, None));
        // ...but a rule without an amount condition still matches.
        let plain = rule("plain", "FOO", RuleMatchType::Contains, 0);
        assert!(matches_amount(&plain, None));
    }

    #[test]
    fn amount_rule_missing_value_never_matches() {
        let mut r = amount_rule("broken", RuleAmountOp::Gt, "1", None, 0);
        r.amount_value = None;
        assert!(!matches_amount(&r, dec("100")));
    }

    #[test]
    fn between_missing_upper_bound_never_matches() {
        let r = amount_rule("half", RuleAmountOp::Between, "10", None, 0);
        assert!(!matches_amount(&r, dec("10")));
    }

    #[test]
    fn negative_amount_is_compared_unsigned() {
        let r = amount_rule("between", RuleAmountOp::Between, "40", Some("60"), 0);
        assert!(matches_amount(&r, dec("-50")));
    }

    #[test]
    fn amount_gate_is_anded_with_text_and_type_gates() {
        let r = amount_rule("combo", RuleAmountOp::Gte, "100", None, 0);
        // Amount matches, text doesn't.
        assert!(match_rules(
            std::slice::from_ref(&r),
            "NO MATCH HERE",
            "WITHDRAWAL",
            "acct1",
            dec("150")
        )
        .is_none());
        // Text matches, amount doesn't (covered by matches_amount negatives too).
        assert!(!matches_amount(&r, dec("50")));

        let mut typed = amount_rule("typed", RuleAmountOp::Gte, "100", None, 0);
        typed.activity_type = Some("DEPOSIT".to_string());
        // Amount + text match, activity type doesn't.
        assert!(!matches_amount(&typed, dec("150")));
    }

    #[test]
    fn amount_gate_filters_before_priority_selection() {
        let high = amount_rule("high", RuleAmountOp::Gte, "1000", None, 10);
        let low = rule("low", "FOO", RuleMatchType::Contains, 1);
        let rules = vec![high, low];
        // Below the high-priority rule's threshold, the low-priority rule wins.
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", dec("50")).unwrap();
        assert_eq!(m.rule.id, "low");
        // At the threshold, the high-priority rule wins.
        let m = match_rules(&rules, "FOO BAR", "WITHDRAWAL", "acct1", dec("1000")).unwrap();
        assert_eq!(m.rule.id, "high");
    }
}
