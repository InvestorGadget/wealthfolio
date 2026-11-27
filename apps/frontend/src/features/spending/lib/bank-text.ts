interface DescribedActivity {
  importedDescription?: string | null;
  notes?: string | null;
}

const present = (text: string | null | undefined): string | undefined =>
  text?.trim() ? text : undefined;

/**
 * The text a categorization rule matches a transaction on: the description
 * its import received, else its notes; blank text is none. Mirrors
 * `Activity::bank_text` in the core crate, and like it returns the text as
 * stored, untrimmed.
 */
export function getBankText(activity: DescribedActivity): string | undefined {
  return present(activity.importedDescription) ?? present(activity.notes);
}

/**
 * The text that names a transaction: the user's notes, or the description its
 * import received when the notes are blank.
 */
export function getTransactionTitle(activity: DescribedActivity): string | undefined {
  return present(activity.notes) ?? present(activity.importedDescription);
}

/**
 * The description the import received, when the user's notes say something
 * else. Categorization rules match this text (`Activity::bank_text` in the
 * core crate), so it is shown beside the notes rather than hidden by them.
 */
export function getDifferingBankText(activity: DescribedActivity): string | undefined {
  const description = present(activity.importedDescription);
  const notes = present(activity.notes);
  if (!description || !notes) return undefined;
  return notes.trim() === description.trim() ? undefined : description;
}
