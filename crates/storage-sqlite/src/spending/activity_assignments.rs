//! Storage adapter for spending::activity_assignments — Diesel impl over the
//! `activity_taxonomy_assignments` table.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use wealthfolio_spending::activity_splits::ActivitySplit;

use anyhow::Result;
use async_trait::async_trait;
use chrono::NaiveDateTime;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::{get_connection, write_actor::DbWriteTx, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{activity_taxonomy_assignments, spending_activity_splits};
use crate::spending::activity_splits::ActivitySplitDB;
use crate::spending::activity_sync::should_sync_activity_local_id_outbox;
use crate::spending::deterministic_ids::activity_taxonomy_assignment_id;
use wealthfolio_core::sync::SyncEntity;
use wealthfolio_spending::activity_assignments::{
    is_category_taxonomy, ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentRepositoryTrait,
    CategoryAssignmentConflicts, NewActivityTaxonomyAssignment, SplitAssignmentConflict,
    SplitAssignmentConflictReason,
};

#[derive(
    Queryable, Identifiable, AsChangeset, Selectable, Serialize, Deserialize, Debug, Clone,
)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::activity_taxonomy_assignments)]
pub struct NewActivityTaxonomyAssignmentDB {
    pub id: String,
    pub activity_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub weight: i32,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

impl crate::sync::SyncOutboxModel for ActivityTaxonomyAssignmentDB {
    const ENTITY: SyncEntity = SyncEntity::ActivityTaxonomyAssignment;
    fn sync_entity_id(&self) -> &str {
        &self.id
    }
}

fn parse_dt(s: &str) -> NaiveDateTime {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|_| chrono::Utc::now().naive_utc())
}

impl From<ActivityTaxonomyAssignmentDB> for ActivityTaxonomyAssignment {
    fn from(db: ActivityTaxonomyAssignmentDB) -> Self {
        Self {
            id: db.id,
            activity_id: db.activity_id,
            taxonomy_id: db.taxonomy_id,
            category_id: db.category_id,
            weight: db.weight,
            source: db.source,
            created_at: parse_dt(&db.created_at),
            updated_at: parse_dt(&db.updated_at),
        }
    }
}

pub struct ActivityTaxonomyAssignmentRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl ActivityTaxonomyAssignmentRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

fn clear_splits_for_activities_tx(
    tx: &mut DbWriteTx<'_>,
    activity_ids: &[String],
) -> wealthfolio_core::Result<()> {
    if activity_ids.is_empty() {
        return Ok(());
    }

    const CHUNK: usize = 500;
    for chunk in activity_ids.chunks(CHUNK) {
        let existing: Vec<(String, String)> = spending_activity_splits::table
            .filter(spending_activity_splits::activity_id.eq_any(chunk))
            .select((
                spending_activity_splits::id,
                spending_activity_splits::activity_id,
            ))
            .load(tx.conn())
            .map_err(StorageError::from)?;
        if existing.is_empty() {
            continue;
        }

        let mut sync_activity_ids = HashSet::new();
        for activity_id in existing
            .iter()
            .map(|(_, activity_id)| activity_id.as_str())
            .collect::<HashSet<_>>()
        {
            if should_sync_activity_local_id_outbox(tx.conn(), activity_id)? {
                sync_activity_ids.insert(activity_id.to_string());
            }
        }

        diesel::delete(
            spending_activity_splits::table
                .filter(spending_activity_splits::activity_id.eq_any(chunk)),
        )
        .execute(tx.conn())
        .map_err(StorageError::from)?;

        for (split_id, activity_id) in existing {
            if sync_activity_ids.contains(&activity_id) {
                tx.delete::<ActivitySplitDB>(split_id);
            }
        }
    }

    Ok(())
}

enum RuleDecision {
    Eligible {
        had_existing: bool,
        replaces_manual: bool,
    },
    Split,
    /// A value set by hand stands. `differs` is whether the rule would have
    /// filed the activity under another one.
    Manual {
        differs: bool,
    },
    Existing,
    Unchanged,
}
/// `replace_manual` is whether this item's activity is one the user allowed
/// the run to replace hand-set values on. Everywhere else a manual assignment
/// ends the decision, whatever the mode.
fn rule_decision(
    conn: &mut SqliteConnection,
    item: &NewActivityTaxonomyAssignment,
    only_uncategorized: bool,
    replace_manual: bool,
) -> wealthfolio_core::Result<RuleDecision> {
    // Splits stand in for the category, so a rule must not write one beside
    // them. A payee is not part of the split and can still be set.
    let replaces_splits = is_category_taxonomy(&item.taxonomy_id);
    if replaces_splits
        && diesel::select(diesel::dsl::exists(
            spending_activity_splits::table
                .filter(spending_activity_splits::activity_id.eq(&item.activity_id)),
        ))
        .get_result::<bool>(conn)
        .map_err(StorageError::from)?
    {
        return Ok(RuleDecision::Split);
    }
    let existing = activity_taxonomy_assignments::table
        .filter(activity_taxonomy_assignments::activity_id.eq(&item.activity_id))
        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&item.taxonomy_id))
        .load::<ActivityTaxonomyAssignmentDB>(conn)
        .map_err(StorageError::from)?;
    if existing
        .iter()
        .any(|a| a.source.eq_ignore_ascii_case("manual"))
    {
        let differs = existing.iter().any(|a| a.category_id != item.category_id);
        if !replace_manual {
            return Ok(RuleDecision::Manual { differs });
        }
        // The rule agrees with the hand-set value: it stays the user's.
        if !differs {
            return Ok(RuleDecision::Unchanged);
        }
        return Ok(RuleDecision::Eligible {
            had_existing: true,
            replaces_manual: true,
        });
    }
    if only_uncategorized && !existing.is_empty() {
        return Ok(RuleDecision::Existing);
    }
    if existing.len() == 1
        && existing[0].category_id == item.category_id
        && existing[0].weight == item.weight
        && existing[0].source == item.source
    {
        return Ok(RuleDecision::Unchanged);
    }
    Ok(RuleDecision::Eligible {
        had_existing: !existing.is_empty(),
        replaces_manual: false,
    })
}

/// Counts the writer's decisions: per value, and per activity where one
/// activity can have two values (its category and its payee) decided.
#[derive(Default)]
struct RuleTally {
    result: wealthfolio_spending::activity_assignments::RuleAssignmentResult,
    changed: HashSet<String>,
    kept_manual: HashSet<String>,
    replaced_manual: HashSet<String>,
}
impl RuleTally {
    fn count(&mut self, item: &NewActivityTaxonomyAssignment, decision: &RuleDecision) {
        let summary = &mut self.result;
        match decision {
            RuleDecision::Eligible {
                replaces_manual, ..
            } => {
                summary.eligible += 1;
                self.changed.insert(item.activity_id.clone());
                if *replaces_manual {
                    self.replaced_manual.insert(item.activity_id.clone());
                }
            }
            RuleDecision::Split => summary.protected_splits += 1,
            RuleDecision::Manual { differs } => {
                summary.protected_manual += 1;
                if *differs {
                    self.kept_manual.insert(item.activity_id.clone());
                    if is_category_taxonomy(&item.taxonomy_id) {
                        summary.kept_manual_categories += 1;
                    } else {
                        summary.kept_manual_payees += 1;
                    }
                }
            }
            RuleDecision::Existing => summary.skipped_existing += 1,
            RuleDecision::Unchanged => summary.unchanged += 1,
        }
    }
    fn finish(self) -> wealthfolio_spending::activity_assignments::RuleAssignmentResult {
        let mut result = self.result;
        result.changed_activities = self.changed.len();
        result.kept_manual_activities = self.kept_manual.len();
        result.replaced_manual_activities = self.replaced_manual.len();
        result
    }
}

#[async_trait]
impl ActivityTaxonomyAssignmentRepositoryTrait for ActivityTaxonomyAssignmentRepository {
    async fn list_for_activity(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let rows = activity_taxonomy_assignments::table
            .filter(activity_taxonomy_assignments::activity_id.eq(activity_id))
            .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_for_activities(
        &self,
        activity_ids: &[String],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        // SQLite has a default 999-parameter cap; chunk to stay safely under.
        const CHUNK: usize = 500;
        let mut out = Vec::new();
        for chunk in activity_ids.chunks(CHUNK) {
            let rows = activity_taxonomy_assignments::table
                .filter(activity_taxonomy_assignments::activity_id.eq_any(chunk))
                .load::<ActivityTaxonomyAssignmentDB>(&mut conn)
                .map_err(StorageError::from)
                .map_err(|e| anyhow::anyhow!(e))?;
            out.extend(rows.into_iter().map(ActivityTaxonomyAssignment::from));
        }
        Ok(out)
    }

    async fn upsert(
        &self,
        new: NewActivityTaxonomyAssignment,
    ) -> Result<ActivityTaxonomyAssignment> {
        let now = chrono::Utc::now().to_rfc3339();
        let NewActivityTaxonomyAssignment {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
        } = new;
        let id = id.unwrap_or_else(|| activity_taxonomy_assignment_id(&activity_id, &taxonomy_id));
        let row = NewActivityTaxonomyAssignmentDB {
            id,
            activity_id,
            taxonomy_id,
            category_id,
            weight,
            source,
            created_at: now.clone(),
            updated_at: now,
        };

        self.writer
            .exec_tx(move |tx| {
                let result = diesel::insert_into(activity_taxonomy_assignments::table)
                    .values(&row)
                    .on_conflict((
                        activity_taxonomy_assignments::activity_id,
                        activity_taxonomy_assignments::taxonomy_id,
                    ))
                    .do_update()
                    .set((
                        activity_taxonomy_assignments::category_id.eq(&row.category_id),
                        activity_taxonomy_assignments::weight.eq(&row.weight),
                        activity_taxonomy_assignments::source.eq(&row.source),
                        activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                    ))
                    .returning(ActivityTaxonomyAssignmentDB::as_returning())
                    .get_result(tx.conn())
                    .map_err(StorageError::from)?;

                if should_sync_activity_local_id_outbox(tx.conn(), &result.activity_id)? {
                    tx.update(&result)?;
                }
                Ok(result)
            })
            .await
            .map(ActivityTaxonomyAssignment::from)
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn assign_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let inserted_dbs: Vec<ActivityTaxonomyAssignmentDB> = self
            .writer
            .exec_tx(move |tx| {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_many_single_select_clearing_splits(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        split_replacements: HashMap<String, Vec<ActivitySplit>>,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        // Only a category stands in the place of an activity's splits. Any
        // other label, like a payee, is written beside them in the same
        // transaction: its activity's splits are neither checked nor cleared.
        let mut seen_activity_ids = HashSet::new();
        let activity_ids = items
            .iter()
            .filter(|item| is_category_taxonomy(&item.taxonomy_id))
            .filter_map(|item| {
                if seen_activity_ids.insert(item.activity_id.clone()) {
                    Some(item.activity_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        let now = chrono::Utc::now().to_rfc3339();
        let outcome = self
            .writer
            .exec_tx(move |tx| {
                // Check every row before changing assignments or emitting outbox entries.
                // Splits may have changed since a native or MCP preview was shown.
                let mut conflicts = Vec::new();
                for activity_id in &activity_ids {
                    let mut current: Vec<ActivitySplit> = spending_activity_splits::table
                        .filter(spending_activity_splits::activity_id.eq(activity_id))
                        .load::<ActivitySplitDB>(tx.conn())
                        .map_err(StorageError::from)?
                        .into_iter()
                        .map(Into::into)
                        .collect();
                    if let Some(expected) = split_replacements.get(activity_id) {
                        let mut expected = expected.clone();
                        current.sort_by(|a, b| a.id.cmp(&b.id));
                        expected.sort_by(|a, b| a.id.cmp(&b.id));
                        if current != expected {
                            conflicts.push(SplitAssignmentConflict {
                                activity_id: activity_id.clone(),
                                reason: SplitAssignmentConflictReason::SplitStateChanged,
                            });
                        }
                    } else if !current.is_empty() {
                        conflicts.push(SplitAssignmentConflict {
                            activity_id: activity_id.clone(),
                            reason: SplitAssignmentConflictReason::ProtectedSplits,
                        });
                    }
                }
                if !conflicts.is_empty() {
                    return Ok(Err(CategoryAssignmentConflicts { conflicts }));
                }
                clear_splits_for_activities_tx(tx, &activity_ids)?;

                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let existing_id = activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .select(activity_taxonomy_assignments::id)
                        .first::<String>(tx.conn())
                        .optional()
                        .map_err(StorageError::from)?;

                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if existing_id.is_some() {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    out.push(inserted);
                }
                Ok(Ok(out))
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        let inserted_dbs = outcome?;
        Ok(inserted_dbs
            .into_iter()
            .map(ActivityTaxonomyAssignment::from)
            .collect())
    }

    async fn assign_rule_many_single_select(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        Ok(self
            .assign_rules_detailed(items, only_uncategorized)
            .await?
            .assignments)
    }
    async fn preview_rules(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        self.preview_rules_replacing_manual(items, only_uncategorized, HashSet::new())
            .await
    }
    async fn preview_rules_replacing_manual(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
        replace_manual_for: HashSet<String>,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let mut tally = RuleTally::default();
        for item in items {
            let decision = rule_decision(
                &mut conn,
                &item,
                only_uncategorized,
                replace_manual_for.contains(&item.activity_id),
            )?;
            tally.count(&item, &decision);
        }
        Ok(tally.finish())
    }
    async fn assign_rules_detailed(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        self.assign_rules_replacing_manual(items, only_uncategorized, HashSet::new())
            .await
    }
    async fn assign_rules_replacing_manual(
        &self,
        items: Vec<NewActivityTaxonomyAssignment>,
        only_uncategorized: bool,
        replace_manual_for: HashSet<String>,
    ) -> Result<wealthfolio_spending::activity_assignments::RuleAssignmentResult> {
        if items.is_empty() {
            return Ok(Default::default());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let result = self
            .writer
            .exec_tx(move |tx| {
                let mut tally = RuleTally::default();
                for item in items {
                    let decision = rule_decision(
                        tx.conn(),
                        &item,
                        only_uncategorized,
                        replace_manual_for.contains(&item.activity_id),
                    )?;
                    tally.count(&item, &decision);
                    let RuleDecision::Eligible { had_existing, .. } = decision else {
                        continue;
                    };
                    let NewActivityTaxonomyAssignment {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                    } = item;
                    let id = id.unwrap_or_else(|| {
                        activity_taxonomy_assignment_id(&activity_id, &taxonomy_id)
                    });
                    let row = NewActivityTaxonomyAssignmentDB {
                        id,
                        activity_id,
                        taxonomy_id,
                        category_id,
                        weight,
                        source,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };

                    let inserted = diesel::insert_into(activity_taxonomy_assignments::table)
                        .values(&row)
                        .on_conflict((
                            activity_taxonomy_assignments::activity_id,
                            activity_taxonomy_assignments::taxonomy_id,
                        ))
                        .do_update()
                        .set((
                            activity_taxonomy_assignments::category_id.eq(&row.category_id),
                            activity_taxonomy_assignments::weight.eq(&row.weight),
                            activity_taxonomy_assignments::source.eq(&row.source),
                            activity_taxonomy_assignments::updated_at.eq(&row.updated_at),
                        ))
                        .returning(ActivityTaxonomyAssignmentDB::as_returning())
                        .get_result::<ActivityTaxonomyAssignmentDB>(tx.conn())
                        .map_err(StorageError::from)?;

                    if should_sync_activity_local_id_outbox(tx.conn(), &inserted.activity_id)? {
                        if had_existing {
                            tx.update(&inserted)?;
                        } else {
                            tx.insert(&inserted)?;
                        }
                    }
                    tally
                        .result
                        .assignments
                        .push(ActivityTaxonomyAssignment::from(inserted));
                    tally.result.changed += 1;
                }
                Ok(tally.finish())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(result)
    }

    async fn reassign_category(
        &self,
        taxonomy_id: &str,
        from_category_id: &str,
        to_category_id: &str,
    ) -> Result<usize> {
        let taxonomy_id = taxonomy_id.to_string();
        let from_category_id = from_category_id.to_string();
        let to_category_id = to_category_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.writer
            .exec_tx(move |tx| {
                let moved = diesel::update(
                    activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                        .filter(activity_taxonomy_assignments::category_id.eq(&from_category_id)),
                )
                .set((
                    activity_taxonomy_assignments::category_id.eq(&to_category_id),
                    activity_taxonomy_assignments::updated_at.eq(&now),
                ))
                .returning(ActivityTaxonomyAssignmentDB::as_returning())
                .get_results::<ActivityTaxonomyAssignmentDB>(tx.conn())
                .map_err(StorageError::from)?;
                for assignment in &moved {
                    if should_sync_activity_local_id_outbox(tx.conn(), &assignment.activity_id)? {
                        tx.update(assignment)?;
                    }
                }
                Ok(moved.len())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing = activity_taxonomy_assignments::table
                    .find(&id)
                    .first::<ActivityTaxonomyAssignmentDB>(tx.conn())
                    .optional()
                    .map_err(StorageError::from)?;
                let should_sync = match &existing {
                    Some(row) => should_sync_activity_local_id_outbox(tx.conn(), &row.activity_id)?,
                    None => false,
                };
                let affected = diesel::delete(activity_taxonomy_assignments::table.find(&id))
                    .execute(tx.conn())
                    .map_err(StorageError::from)?;
                if affected > 0 && should_sync {
                    tx.delete::<ActivityTaxonomyAssignmentDB>(id.clone());
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        let activity_id = activity_id.to_string();
        let taxonomy_id = taxonomy_id.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing_ids = activity_taxonomy_assignments::table
                    .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                    .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id))
                    .select(activity_taxonomy_assignments::id)
                    .load::<String>(tx.conn())
                    .map_err(StorageError::from)?;
                let should_sync = should_sync_activity_local_id_outbox(tx.conn(), &activity_id)?;

                diesel::delete(
                    activity_taxonomy_assignments::table
                        .filter(activity_taxonomy_assignments::activity_id.eq(&activity_id))
                        .filter(activity_taxonomy_assignments::taxonomy_id.eq(&taxonomy_id)),
                )
                .execute(tx.conn())
                .map_err(StorageError::from)?;

                if should_sync {
                    for assignment_id in existing_ids {
                        tx.delete::<ActivityTaxonomyAssignmentDB>(assignment_id);
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        create_pool, get_connection, init, run_migrations, write_actor::spawn_writer, TestDir,
    };
    use crate::schema::{
        activities, activity_taxonomy_assignments, spending_activity_splits, sync_outbox,
    };
    use diesel::r2d2::{ConnectionManager, Pool};
    use std::sync::Arc;
    use wealthfolio_spending::activity_assignments::{
        ActivityTaxonomyAssignmentRepositoryTrait, NewActivityTaxonomyAssignment,
    };

    fn setup_db() -> (
        Arc<Pool<ConnectionManager<SqliteConnection>>>,
        WriteHandle,
        TestDir,
    ) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let dir = TestDir::new();
        let app_data = dir.path().to_string_lossy().to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer, dir)
    }

    fn insert_account_and_activity(conn: &mut SqliteConnection, id: &str, source_system: &str) {
        let account_id = format!("account-{id}");
        diesel::sql_query(format!(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('{}', 'Account {}', 'cash', NULL, 'USD', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, \
                     NULL, NULL, NULL, NULL, NULL, 0, 'portfolio')",
            account_id, id
        ))
        .execute(conn)
        .expect("insert account");

        diesel::sql_query(format!(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{}', '{}', NULL, 'BUY', NULL, NULL, NULL, 'POSTED', \
                     '2026-01-01T00:00:00Z', NULL, NULL, NULL, '10', NULL, 'USD', NULL, \
                     NULL, NULL, '{}', '{}-source-record', NULL, NULL, NULL, 0, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, account_id, source_system, id
        ))
        .execute(conn)
        .expect("insert activity");
    }

    fn outbox_count(conn: &mut SqliteConnection) -> i64 {
        sync_outbox::table
            .count()
            .get_result::<i64>(conn)
            .expect("count outbox")
    }

    fn mark_activity_user_modified(conn: &mut SqliteConnection, activity_id: &str) {
        diesel::update(activities::table.find(activity_id))
            .set(activities::is_user_modified.eq(1))
            .execute(conn)
            .expect("mark activity user modified");
    }

    fn insert_split(conn: &mut SqliteConnection, id: &str, activity_id: &str) {
        diesel::sql_query(format!(
            "INSERT INTO spending_activity_splits \
             (id, activity_id, taxonomy_id, category_id, amount, note, sort_order, created_at, updated_at) \
             VALUES ('{}', '{}', 'spending_categories', 'cat_food', '10', NULL, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            id, activity_id
        ))
        .execute(conn)
        .expect("insert split");
    }

    #[tokio::test]
    async fn rule_reruns_preserve_split_allocations_in_both_modes() {
        for only_uncategorized in [true, false] {
            let (pool, writer, _dir) = setup_db();
            {
                let mut conn = get_connection(&pool).expect("conn");
                insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
                insert_split(&mut conn, "split-1", "split-activity");
            }
            let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
            let applied = repo
                .assign_rule_many_single_select(
                    vec![NewActivityTaxonomyAssignment {
                        id: None,
                        activity_id: "split-activity".to_string(),
                        taxonomy_id: "spending_categories".to_string(),
                        category_id: "cat_groceries".to_string(),
                        weight: 10_000,
                        source: "rule".to_string(),
                    }],
                    only_uncategorized,
                )
                .await
                .expect("rerun rules");
            assert!(applied.is_empty());
            assert!(repo
                .list_for_activity("split-activity")
                .await
                .unwrap()
                .is_empty());
            let mut conn = get_connection(&pool).expect("conn");
            assert_eq!(
                spending_activity_splits::table
                    .count()
                    .get_result::<i64>(&mut conn)
                    .unwrap(),
                1
            );
        }
    }

    #[tokio::test]
    async fn a_payee_rule_reaches_a_split_activity_and_leaves_its_splits() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            diesel::sql_query(
                "INSERT INTO taxonomy_categories \
                 (id, taxonomy_id, name, key, color, sort_order, created_at, updated_at) \
                 VALUES ('payee_bakery', 'payees', 'Corner Bakery', 'payee_bakery', '#5B7C99', 0, \
                         '2026-01-01', '2026-01-01')",
            )
            .execute(&mut conn)
            .expect("insert payee");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);

        let applied = repo
            .assign_rule_many_single_select(
                vec![NewActivityTaxonomyAssignment {
                    id: None,
                    activity_id: "split-activity".to_string(),
                    taxonomy_id: "payees".to_string(),
                    category_id: "payee_bakery".to_string(),
                    weight: 10_000,
                    source: "rule".to_string(),
                }],
                true,
            )
            .await
            .expect("rerun rules");

        assert_eq!(applied.len(), 1, "the payee is not part of the split");
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn ordinary_bulk_assignment_rejects_split_rows_atomically() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let items = ["ordinary", "split-activity"]
            .map(|id| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: id.to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .to_vec();
        assert!(repo
            .assign_many_single_select_clearing_splits(items, HashMap::new())
            .await
            .is_err());
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        assert!(repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    fn insert_payee(conn: &mut SqliteConnection, id: &str) {
        diesel::sql_query(format!(
            "INSERT INTO taxonomy_categories \
             (id, taxonomy_id, name, key, color, sort_order, created_at, updated_at) \
             VALUES ('{id}', 'payees', '{id}', '{id}', '#5B7C99', 0, '2026-01-01', '2026-01-01')",
        ))
        .execute(conn)
        .expect("insert payee");
    }

    fn manual(
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> NewActivityTaxonomyAssignment {
        NewActivityTaxonomyAssignment {
            id: None,
            activity_id: activity_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        }
    }

    #[tokio::test]
    async fn a_refused_category_leaves_the_payees_of_its_batch_unwritten() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            insert_payee(&mut conn, "payee_bakery");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);

        let refused = repo
            .assign_many_single_select_clearing_splits(
                vec![
                    manual("ordinary", "payees", "payee_bakery"),
                    // Its splits were not reviewed, so the batch is refused.
                    manual("split-activity", "spending_categories", "cat_groceries"),
                ],
                HashMap::new(),
            )
            .await;

        assert!(refused.is_err());
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(outbox_count(&mut conn), 0);
    }

    #[tokio::test]
    async fn a_payee_that_fails_to_write_takes_back_the_categories_written_before_it() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "other", "MANUAL");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);

        let failed = repo
            .assign_many_single_select_clearing_splits(
                vec![
                    manual("ordinary", "spending_categories", "cat_groceries"),
                    // No such payee: the foreign key refuses the row.
                    manual("other", "payees", "payee_missing"),
                ],
                HashMap::new(),
            )
            .await;

        assert!(failed.is_err());
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(outbox_count(&mut conn), 0);
    }

    #[tokio::test]
    async fn a_batch_of_payees_alone_replaces_a_payee_and_leaves_the_splits() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            insert_payee(&mut conn, "payee_bakery");
            insert_payee(&mut conn, "payee_water");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        for payee in ["payee_bakery", "payee_water"] {
            repo.assign_many_single_select_clearing_splits(
                vec![manual("split-activity", "payees", payee)],
                HashMap::new(),
            )
            .await
            .expect("a payee is not refused by splits");
        }

        let filed: Vec<String> = repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .into_iter()
            .map(|assignment| assignment.category_id)
            .collect();
        assert_eq!(filed, vec!["payee_water"]);
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn a_split_activity_takes_a_category_and_a_payee_in_one_batch_once_reviewed() {
        let (pool, writer, _dir) = setup_db();
        let reviewed = {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            insert_payee(&mut conn, "payee_bakery");
            spending_activity_splits::table
                .load::<ActivitySplitDB>(&mut conn)
                .unwrap()
                .into_iter()
                .map(ActivitySplit::from)
                .collect::<Vec<_>>()
        };
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let batch = || {
            vec![
                manual("split-activity", "payees", "payee_bakery"),
                manual("split-activity", "spending_categories", "cat_groceries"),
            ]
        };
        let split_count = || {
            let mut conn = get_connection(&pool).expect("conn");
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap()
        };

        // The category would replace splits nobody reviewed: neither is written.
        assert!(repo
            .assign_many_single_select_clearing_splits(batch(), HashMap::new())
            .await
            .is_err());
        assert!(repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(split_count(), 1);

        let written = repo
            .assign_many_single_select_clearing_splits(
                batch(),
                HashMap::from([("split-activity".to_string(), reviewed)]),
            )
            .await
            .expect("reviewed splits are replaced by the category");

        assert_eq!(written.len(), 2);
        assert_eq!(
            repo.list_for_activity("split-activity")
                .await
                .unwrap()
                .len(),
            2
        );
        // Cleared for the category; a payee alone leaves them, as tested above.
        assert_eq!(split_count(), 0);
    }

    #[tokio::test]
    async fn a_payee_and_a_category_are_written_together_and_the_payee_keeps_its_splits() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            insert_payee(&mut conn, "payee_bakery");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);

        let written = repo
            .assign_many_single_select_clearing_splits(
                vec![
                    manual("split-activity", "payees", "payee_bakery"),
                    manual("ordinary", "spending_categories", "cat_groceries"),
                ],
                HashMap::new(),
            )
            .await
            .expect("a payee is not refused by splits");

        assert_eq!(written.len(), 2);
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn reassigning_a_category_moves_its_assignments_and_keeps_their_source() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            for id in ["by-hand", "by-rule", "elsewhere"] {
                insert_account_and_activity(&mut conn, id, "MANUAL");
            }
            for id in ["payee_old", "payee_new", "payee_other"] {
                insert_payee(&mut conn, id);
            }
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.assign_many_single_select(vec![
            manual("by-hand", "payees", "payee_old"),
            NewActivityTaxonomyAssignment {
                source: "rule".to_string(),
                ..manual("by-rule", "payees", "payee_old")
            },
            manual("elsewhere", "payees", "payee_other"),
        ])
        .await
        .expect("file under payees");
        let outbox_before = outbox_count(&mut get_connection(&pool).expect("conn"));

        let moved = repo
            .reassign_category("payees", "payee_old", "payee_new")
            .await
            .expect("reassign");

        assert_eq!(moved, 2);
        let filed = |assignments: Vec<ActivityTaxonomyAssignment>| {
            assignments
                .into_iter()
                .map(|a| (a.category_id, a.source))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            filed(repo.list_for_activity("by-hand").await.unwrap()),
            vec![("payee_new".to_string(), "manual".to_string())]
        );
        assert_eq!(
            filed(repo.list_for_activity("by-rule").await.unwrap()),
            vec![("payee_new".to_string(), "rule".to_string())]
        );
        assert_eq!(
            filed(repo.list_for_activity("elsewhere").await.unwrap()),
            vec![("payee_other".to_string(), "manual".to_string())]
        );
        // Each moved assignment is sent to the other devices.
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(outbox_count(&mut conn), outbox_before + 2);
    }

    #[tokio::test]
    async fn stale_split_content_rejects_the_whole_replacement() {
        let (pool, writer, _dir) = setup_db();
        let expected = {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "ordinary", "MANUAL");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            let expected = spending_activity_splits::table
                .load::<ActivitySplitDB>(&mut conn)
                .unwrap()
                .into_iter()
                .map(ActivitySplit::from)
                .collect::<Vec<_>>();
            // Same ID and timestamps: comparing identifiers alone loses this edit.
            diesel::update(spending_activity_splits::table.find("split-1"))
                .set(spending_activity_splits::note.eq("Changed after review"))
                .execute(&mut conn)
                .unwrap();
            expected
        };
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let items = ["ordinary", "split-activity"]
            .map(|id| NewActivityTaxonomyAssignment {
                id: None,
                activity_id: id.to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            })
            .to_vec();
        let error = repo
            .assign_many_single_select_clearing_splits(
                items,
                HashMap::from([("split-activity".to_string(), expected)]),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("changed"));
        assert!(repo.list_for_activity("ordinary").await.unwrap().is_empty());
        assert!(repo
            .list_for_activity("split-activity")
            .await
            .unwrap()
            .is_empty());
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .find("split-1")
                .select(spending_activity_splits::note)
                .first::<Option<String>>(&mut conn)
                .unwrap(),
            Some("Changed after review".to_string())
        );
        assert_eq!(
            crate::schema::sync_outbox::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn assigning_category_clears_existing_splits_in_same_write() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "manual-activity");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        let expected = {
            let mut conn = get_connection(&pool).expect("conn");
            spending_activity_splits::table
                .load::<ActivitySplitDB>(&mut conn)
                .unwrap()
                .into_iter()
                .map(ActivitySplit::from)
                .collect::<Vec<_>>()
        };
        repo.assign_many_single_select_clearing_splits(
            vec![NewActivityTaxonomyAssignment {
                id: None,
                activity_id: "manual-activity".to_string(),
                taxonomy_id: "spending_categories".to_string(),
                category_id: "cat_groceries".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
            }],
            HashMap::from([("manual-activity".to_string(), expected)]),
        )
        .await
        .expect("assign category");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count splits"),
            0
        );
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
    }

    #[tokio::test]
    async fn broker_activity_assignment_is_local_only_but_manual_assignment_still_syncs() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "broker-activity", "SNAPTRADE");
            mark_activity_user_modified(&mut conn, "broker-activity");
            insert_account_and_activity(&mut conn, "manual-activity", "MANUAL");
        }

        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "broker-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_food".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            activity_taxonomy_assignments::table
                .count()
                .get_result::<i64>(&mut conn)
                .expect("count assignments"),
            1
        );
        assert_eq!(outbox_count(&mut conn), 0);

        repo.upsert(NewActivityTaxonomyAssignment {
            id: None,
            activity_id: "manual-activity".to_string(),
            taxonomy_id: "spending_categories".to_string(),
            category_id: "cat_groceries".to_string(),
            weight: 10_000,
            source: "manual".to_string(),
        })
        .await
        .expect("assign manual activity");

        let entities = sync_outbox::table
            .select(sync_outbox::entity)
            .load::<String>(&mut conn)
            .expect("load outbox entities");
        assert_eq!(entities, vec!["activity_taxonomy_assignment".to_string()]);
    }

    // ----- rule runs and values set by hand --------------------------------

    fn by_rule(activity: &str, taxonomy: &str, category: &str) -> NewActivityTaxonomyAssignment {
        NewActivityTaxonomyAssignment {
            source: "rule".to_string(),
            ..manual(activity, taxonomy, category)
        }
    }

    fn only(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    /// `(category_id, source)` of every assignment of an activity, by taxonomy.
    async fn stored(
        repo: &ActivityTaxonomyAssignmentRepository,
        activity: &str,
    ) -> Vec<(String, String, String)> {
        let mut rows: Vec<_> = repo
            .list_for_activity(activity)
            .await
            .expect("list assignments")
            .into_iter()
            .map(|a| (a.taxonomy_id, a.category_id, a.source))
            .collect();
        rows.sort();
        rows
    }

    fn row(taxonomy: &str, category: &str, source: &str) -> (String, String, String) {
        (taxonomy.into(), category.into(), source.into())
    }

    /// Two activities, each with a category and a payee the user set by hand.
    async fn hand_categorized() -> (ActivityTaxonomyAssignmentRepository, TestDir) {
        let (pool, writer, dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "listed", "MANUAL");
            insert_account_and_activity(&mut conn, "unlisted", "MANUAL");
            insert_payee(&mut conn, "payee_friend");
            insert_payee(&mut conn, "payee_bakery");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool, writer);
        repo.assign_many_single_select(vec![
            manual("listed", "spending_categories", "cat_food"),
            manual("listed", "payees", "payee_friend"),
            manual("unlisted", "spending_categories", "cat_food"),
            manual("unlisted", "payees", "payee_friend"),
        ])
        .await
        .expect("assign by hand");
        (repo, dir)
    }

    fn rule_items() -> Vec<NewActivityTaxonomyAssignment> {
        vec![
            by_rule("listed", "spending_categories", "cat_groceries"),
            by_rule("listed", "payees", "payee_bakery"),
            by_rule("unlisted", "spending_categories", "cat_groceries"),
            by_rule("unlisted", "payees", "payee_bakery"),
        ]
    }

    #[tokio::test]
    async fn a_rule_run_without_the_override_never_replaces_a_value_set_by_hand() {
        for only_uncategorized in [true, false] {
            let (repo, _dir) = hand_categorized().await;

            let preview = repo
                .preview_rules(rule_items(), only_uncategorized)
                .await
                .expect("preview");
            let result = repo
                .assign_rules_detailed(rule_items(), only_uncategorized)
                .await
                .expect("run rules");

            for summary in [&preview, &result] {
                assert_eq!(summary.eligible, 0);
                assert_eq!(summary.changed_activities, 0);
                assert_eq!(summary.protected_manual, 4);
                assert_eq!(summary.kept_manual_activities, 2);
                assert_eq!(summary.kept_manual_categories, 2);
                assert_eq!(summary.kept_manual_payees, 2);
                assert_eq!(summary.replaced_manual_activities, 0);
            }
            assert!(result.assignments.is_empty());
            for activity in ["listed", "unlisted"] {
                assert_eq!(
                    stored(&repo, activity).await,
                    vec![
                        row("payees", "payee_friend", "manual"),
                        row("spending_categories", "cat_food", "manual"),
                    ]
                );
            }
        }
    }

    #[tokio::test]
    async fn the_override_replaces_values_set_by_hand_only_on_the_listed_activities() {
        for only_uncategorized in [true, false] {
            let (repo, _dir) = hand_categorized().await;

            let preview = repo
                .preview_rules_replacing_manual(rule_items(), only_uncategorized, only(&["listed"]))
                .await
                .expect("preview");
            // The preview writes nothing.
            assert_eq!(
                stored(&repo, "listed").await,
                vec![
                    row("payees", "payee_friend", "manual"),
                    row("spending_categories", "cat_food", "manual"),
                ]
            );
            let result = repo
                .assign_rules_replacing_manual(rule_items(), only_uncategorized, only(&["listed"]))
                .await
                .expect("run rules");

            for summary in [&preview, &result] {
                assert_eq!(summary.eligible, 2);
                assert_eq!(summary.changed_activities, 1);
                assert_eq!(summary.replaced_manual_activities, 1);
                assert_eq!(summary.protected_manual, 2);
                assert_eq!(summary.kept_manual_activities, 1);
            }
            assert_eq!(result.changed, 2);
            assert_eq!(
                stored(&repo, "listed").await,
                vec![
                    row("payees", "payee_bakery", "rule"),
                    row("spending_categories", "cat_groceries", "rule"),
                ]
            );
            assert_eq!(
                stored(&repo, "unlisted").await,
                vec![
                    row("payees", "payee_friend", "manual"),
                    row("spending_categories", "cat_food", "manual"),
                ]
            );
        }
    }

    #[tokio::test]
    async fn the_override_leaves_a_hand_set_value_the_rule_agrees_with() {
        let (repo, _dir) = hand_categorized().await;

        let result = repo
            .assign_rules_replacing_manual(
                vec![
                    by_rule("listed", "spending_categories", "cat_food"),
                    by_rule("listed", "payees", "payee_bakery"),
                ],
                false,
                only(&["listed"]),
            )
            .await
            .expect("run rules");

        assert_eq!(result.unchanged, 1);
        assert_eq!(result.changed, 1);
        assert_eq!(
            stored(&repo, "listed").await,
            vec![
                row("payees", "payee_bakery", "rule"),
                // Still the user's: a later protected run keeps it.
                row("spending_categories", "cat_food", "manual"),
            ]
        );
    }

    #[tokio::test]
    async fn a_hand_set_value_the_rule_agrees_with_is_not_counted_as_kept() {
        let (repo, _dir) = hand_categorized().await;

        let preview = repo
            .preview_rules(
                vec![
                    by_rule("listed", "spending_categories", "cat_food"),
                    by_rule("listed", "payees", "payee_bakery"),
                    by_rule("unlisted", "spending_categories", "cat_food"),
                ],
                false,
            )
            .await
            .expect("preview");

        assert_eq!(preview.protected_manual, 3);
        assert_eq!(preview.kept_manual_activities, 1);
        assert_eq!(preview.kept_manual_categories, 0);
        assert_eq!(preview.kept_manual_payees, 1);
    }

    #[tokio::test]
    async fn the_override_does_not_reach_past_split_protection() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "split-activity", "MANUAL");
            insert_split(&mut conn, "split-1", "split-activity");
            insert_payee(&mut conn, "payee_friend");
            insert_payee(&mut conn, "payee_bakery");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool.clone(), writer);
        repo.assign_many_single_select_clearing_splits(
            vec![manual("split-activity", "payees", "payee_friend")],
            HashMap::new(),
        )
        .await
        .expect("assign payee by hand");
        let items = || {
            vec![
                by_rule("split-activity", "spending_categories", "cat_groceries"),
                by_rule("split-activity", "payees", "payee_bakery"),
            ]
        };

        let preview = repo
            .preview_rules_replacing_manual(items(), false, only(&["split-activity"]))
            .await
            .expect("preview");
        let result = repo
            .assign_rules_replacing_manual(items(), false, only(&["split-activity"]))
            .await
            .expect("run rules");

        for summary in [&preview, &result] {
            assert_eq!(summary.protected_splits, 1);
            assert_eq!(summary.eligible, 1);
        }
        // The payee is not part of the split, so the override reaches it; the
        // category the splits stand in for is not written.
        assert_eq!(
            stored(&repo, "split-activity").await,
            vec![row("payees", "payee_bakery", "rule")]
        );
        let mut conn = get_connection(&pool).expect("conn");
        assert_eq!(
            spending_activity_splits::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn a_preview_counts_changed_activities_once_across_taxonomies() {
        let (pool, writer, _dir) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_and_activity(&mut conn, "fresh", "MANUAL");
            insert_account_and_activity(&mut conn, "filed", "MANUAL");
            insert_payee(&mut conn, "payee_bakery");
        }
        let repo = ActivityTaxonomyAssignmentRepository::new(pool, writer);
        repo.assign_rule_many_single_select(
            vec![by_rule("filed", "spending_categories", "cat_groceries")],
            false,
        )
        .await
        .expect("first run");

        let preview = repo
            .preview_rules(
                vec![
                    by_rule("fresh", "spending_categories", "cat_groceries"),
                    by_rule("fresh", "payees", "payee_bakery"),
                    by_rule("filed", "spending_categories", "cat_groceries"),
                ],
                false,
            )
            .await
            .expect("preview");

        assert_eq!(preview.eligible, 2);
        assert_eq!(preview.changed_activities, 1);
        assert_eq!(preview.unchanged, 1);
        assert_eq!(preview.kept_manual_activities, 0);
        assert!(stored(&repo, "fresh").await.is_empty());
    }
}
