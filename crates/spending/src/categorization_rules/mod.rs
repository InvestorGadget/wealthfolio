//! Activity rules — pattern-based auto-categorization for activities.
//! The rule with the highest priority that matches an activity's bank text
//! (its imported description, else its notes; `Activity::bank_text`) and
//! optionally its `activity_type` wins; its category assignment is created.

pub mod matcher;
pub mod model;
pub mod presets;
pub mod service;
pub mod traits;

pub use matcher::{compile_regex_pattern, match_rules, RuleMatch, MAX_REGEX_PATTERN_LEN};
pub use model::{
    is_text_condition, CategorizationRule, CategorizationRunSummary, NewCategorizationRule,
    RuleAmountOp, RuleMatchType, UpdateCategorizationRule, NO_TEXT_CONDITION_PATTERN,
};
pub use presets::{ImportPresetResult, RemovePresetResult, RulePreset, RulePresetSummary};
pub use service::CategorizationRulesService;
pub use traits::{
    CategorizationRulesRepositoryTrait, CategorizationRulesServiceTrait, PresetImportCounts,
};
