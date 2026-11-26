import type { CategorizationRule, RuleMatchType } from "../types/rule";

/**
 * The pattern a rule without a text condition is stored with, beside
 * `matchType: "regex"`. Mirrors `NO_TEXT_CONDITION_PATTERN` in
 * `wealthfolio_spending::categorization_rules`: it never compiles there, so a
 * version that does not know payee conditions never matches such a rule.
 * It is never shown: the form reads it as an empty text condition.
 */
export const NO_TEXT_CONDITION_PATTERN = "(?!)";

/** Mirrors `MAX_REGEX_PATTERN_LEN` in `wealthfolio_spending::categorization_rules`. */
export const MAX_REGEX_PATTERN_LENGTH = 512;

/**
 * Whether the rule matches on the transaction's text at all. Mirrors
 * `is_text_condition`: only the placeholder is none. An empty pattern, which
 * earlier versions saved for catch-all rules, is a text every transaction
 * meets.
 */
export function hasTextCondition(rule: Pick<CategorizationRule, "pattern" | "matchType">): boolean {
  return !(rule.matchType === "regex" && rule.pattern === NO_TEXT_CONDITION_PATTERN);
}

/** How a list of texts is matched: any of them somewhere in the notes, or as the whole of them. */
export type AnyOfMode = "contains" | "exact";

export interface AnyOfCondition {
  mode: AnyOfMode;
  items: string[];
}

// The characters `regex::escape` escapes. A list is stored as a regex of
// exactly this shape, so that versions without the list mode match it too:
//   contains  (?i)(?:A|B|C)
//   exact     (?i)^(?:A|B|C)$
// `(?i)` keeps it case-insensitive, like the other match types.
const META = /[\\.+*?()|[\]{}^$#&\-~]/;
const META_GLOBAL = new RegExp(META.source, "g");
const PREFIX = "(?i)";

const escapeLiteral = (text: string): string => text.replace(META_GLOBAL, "\\$&");

/** The texts of a list as typed, one per line: trimmed, without blanks or repeats. */
export function parseAnyOfInput(input: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const line of input.split("\n")) {
    const item = line.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

/** The regex a list of texts is stored as. */
export function compileAnyOfPattern({ mode, items }: AnyOfCondition): string {
  const group = `(?:${items.map(escapeLiteral).join("|")})`;
  return mode === "exact" ? `${PREFIX}^${group}$` : `${PREFIX}${group}`;
}

/**
 * Reads a stored regex back as the list it was compiled from, or null when it
 * is anything else.
 *
 * The parse is strict rather than marked: the shape above with nothing but
 * escaped literals between the bars. A regex someone wrote by hand in exactly
 * that shape means the same as the list, so showing it as one loses nothing,
 * and compiling the list again gives back the same string.
 */
export function parseAnyOfPattern(pattern: string): AnyOfCondition | null {
  if (!pattern.startsWith(PREFIX)) return null;
  let body = pattern.slice(PREFIX.length);
  const anchored = body.startsWith("^");
  if (anchored) {
    if (!body.endsWith("$")) return null;
    body = body.slice(1, -1);
  }
  // An unanchored list ends with its group; `...)$` without `^` does not.
  if (!body.startsWith("(?:") || !body.endsWith(")")) return null;
  body = body.slice(3, -1);

  const items: string[] = [];
  let item = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      const escaped = body[i + 1];
      // Only an escaped metacharacter is a literal; `\d`, `\b`, a trailing
      // backslash and the like are regex, not text.
      if (escaped === undefined || !META.test(escaped)) return null;
      item += escaped;
      i++;
    } else if (char === "|") {
      items.push(item);
      item = "";
    } else if (META.test(char)) {
      return null;
    } else {
      item += char;
    }
  }
  items.push(item);
  // What the form would not have produced is not a list of the form's.
  if (items.some((entry) => entry === "" || entry !== entry.trim())) return null;
  return { mode: anchored ? "exact" : "contains", items };
}

/** The text condition of a rule as the form edits it. */
export type TextConditionMode = RuleMatchType | "any_contains" | "any_exact";

export interface TextConditionDraft {
  mode: TextConditionMode;
  /** The pattern, for the single-text modes. */
  pattern: string;
  /** The texts, one per line, for the list modes. */
  list: string;
}

/** What the form shows for a stored rule. */
export function textConditionDraft(
  rule?: Pick<CategorizationRule, "pattern" | "matchType">,
): TextConditionDraft {
  if (!rule || !hasTextCondition(rule)) return { mode: "contains", pattern: "", list: "" };
  if (rule.matchType === "regex") {
    const anyOf = parseAnyOfPattern(rule.pattern);
    if (anyOf) {
      return {
        mode: anyOf.mode === "exact" ? "any_exact" : "any_contains",
        pattern: "",
        list: anyOf.items.join("\n"),
      };
    }
  }
  return { mode: rule.matchType, pattern: rule.pattern, list: "" };
}

export const isAnyOfMode = (mode: TextConditionMode): mode is "any_contains" | "any_exact" =>
  mode === "any_contains" || mode === "any_exact";

/**
 * What is stored for the form's text condition. A single text is sent as
 * typed, under its match type, even when it is blank: the server stores the
 * placeholder for a blank one when the rule has a payee condition, keeps the
 * blank pattern of a rule an earlier version saved, and refuses it on any
 * other rule. An empty list is sent as an empty `contains` pattern.
 */
export function storedTextCondition(draft: TextConditionDraft): {
  pattern: string;
  matchType: RuleMatchType;
} {
  if (isAnyOfMode(draft.mode)) {
    const items = parseAnyOfInput(draft.list);
    if (items.length === 0) return { pattern: "", matchType: "contains" };
    return {
      pattern: compileAnyOfPattern({
        mode: draft.mode === "any_exact" ? "exact" : "contains",
        items,
      }),
      matchType: "regex",
    };
  }
  // Kept as typed: a space around a fragment is part of what it matches.
  return { pattern: draft.pattern, matchType: draft.mode };
}
