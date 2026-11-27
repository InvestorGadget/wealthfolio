import { deleteCategory } from "@/adapters";

import { movePayeeActivities, searchCashActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import type { UpdateCategorizationRule } from "../types/rule";
import { PAYEES_TAXONOMY_ID } from "./payee";
import { NO_BANK_TEXTS, summarizeBankTexts, type BankTextSummary } from "./payee-rules";

/** How many of a payee's transactions are read for their bank texts: the most recent ones. */
const BANK_TEXT_SAMPLE = 1000;

/**
 * The bank texts of the transactions filed under a payee, in Spending. Read
 * for the rule a merge offers afterwards, so failing to read them is not a
 * reason to stop the merge: it then offers nothing.
 */
async function payeeBankTexts(payeeId: string): Promise<BankTextSummary> {
  try {
    const { items } = await searchCashActivities({ payeeIds: [payeeId], limit: BANK_TEXT_SAMPLE });
    return summarizeBankTexts(items);
  } catch {
    return NO_BANK_TEXTS;
  }
}

/**
 * Moves everything filed under one payee to another, then deletes the first.
 *
 * The transactions move in one write, on every account: one left on an
 * account no longer in Spending would keep the payee from being deleted. The
 * rules and the delete are ordinary writes after it, not one transaction. A
 * rule is moved wherever it names the payee: as its target, as the payee it
 * matches on, or as the payee it also sets.
 * Each step only moves things toward the destination, and the delete at the
 * end is refused by the server while anything still points at the source, so
 * a merge that stops halfway loses nothing and finishes when it is run again.
 *
 * Returns the bank texts the source's transactions carried. They are read
 * before the move: afterwards nothing tells them from the destination's own.
 */
export async function mergePayee(
  sourceId: string,
  destinationId: string,
): Promise<BankTextSummary> {
  if (sourceId === destinationId) throw new Error("A payee cannot be merged into itself");

  const bankTexts = await payeeBankTexts(sourceId);
  await movePayeeActivities(sourceId, destinationId);

  const rules = await listCategorizationRules();
  for (const rule of rules) {
    const patch: UpdateCategorizationRule = {};
    if (rule.taxonomyId === PAYEES_TAXONOMY_ID && rule.categoryId === sourceId) {
      patch.categoryId = destinationId;
    }
    if (rule.payeeConditionId === sourceId) patch.payeeConditionId = destinationId;
    if (rule.setPayeeId === sourceId) patch.setPayeeId = destinationId;
    if (Object.keys(patch).length === 0) continue;
    await updateCategorizationRule(rule.id, patch);
  }

  await deleteCategory(PAYEES_TAXONOMY_ID, sourceId);
  return bankTexts;
}
