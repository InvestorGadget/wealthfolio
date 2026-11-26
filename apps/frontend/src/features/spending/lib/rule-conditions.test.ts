import { describe, expect, it } from "vitest";

import {
  compileAnyOfPattern,
  hasTextCondition,
  NO_TEXT_CONDITION_PATTERN,
  parseAnyOfInput,
  parseAnyOfPattern,
  storedTextCondition,
  textConditionDraft,
} from "./rule-conditions";

describe("hasTextCondition", () => {
  it("reads the placeholder and an empty pattern as no text condition", () => {
    expect(hasTextCondition({ pattern: NO_TEXT_CONDITION_PATTERN, matchType: "regex" })).toBe(
      false,
    );
    expect(hasTextCondition({ pattern: "  ", matchType: "contains" })).toBe(false);
    expect(hasTextCondition({ pattern: "AMAZON", matchType: "contains" })).toBe(true);
    // As plain text the placeholder is text like any other.
    expect(hasTextCondition({ pattern: NO_TEXT_CONDITION_PATTERN, matchType: "exact" })).toBe(true);
  });
});

describe("parseAnyOfInput", () => {
  it("keeps one text per line, trimmed, without blanks or repeats", () => {
    expect(parseAnyOfInput(" Netflix \n\nSPOTIFY\nnetflix\n  \nDisney+")).toEqual([
      "Netflix",
      "SPOTIFY",
      "Disney+",
    ]);
  });
});

describe("compileAnyOfPattern", () => {
  it("compiles a contains list to a case-insensitive alternation", () => {
    expect(compileAnyOfPattern({ mode: "contains", items: ["NETFLIX", "SPOTIFY"] })).toBe(
      "(?i)(?:NETFLIX|SPOTIFY)",
    );
  });

  it("anchors an exact list", () => {
    expect(compileAnyOfPattern({ mode: "exact", items: ["NETFLIX", "SPOTIFY"] })).toBe(
      "(?i)^(?:NETFLIX|SPOTIFY)$",
    );
  });

  it("escapes what a regex would read as syntax", () => {
    expect(
      compileAnyOfPattern({ mode: "contains", items: ["AT&T", "Disney+", "A|B", "C.O.D. (x)"] }),
    ).toBe("(?i)(?:AT\\&T|Disney\\+|A\\|B|C\\.O\\.D\\. \\(x\\))");
    // Every character `regex::escape` escapes.
    expect(compileAnyOfPattern({ mode: "contains", items: ["\\.+*?()|[]{}^$#&-~"] })).toBe(
      "(?i)(?:\\\\\\.\\+\\*\\?\\(\\)\\|\\[\\]\\{\\}\\^\\$\\#\\&\\-\\~)",
    );
  });

  it("compiles to a regex that matches as the list reads", () => {
    // The stored pattern is a Rust regex; this shape reads the same in JS
    // once the inline flag is made a flag.
    const matches = (mode: "contains" | "exact", items: string[], text: string) => {
      const pattern = compileAnyOfPattern({ mode, items });
      expect(pattern.startsWith("(?i)")).toBe(true);
      // `#`, `&`, `-` and `~` need no escape in JS without the `u` flag.
      return new RegExp(pattern.slice(4), "i").test(text);
    };
    expect(matches("contains", ["AT&T", "Disney+"], "pos disney+ 123")).toBe(true);
    expect(matches("contains", ["AT&T", "Disney+"], "pos disneyy 123")).toBe(false);
    expect(matches("contains", ["A.B"], "AxB")).toBe(false);
    expect(matches("exact", ["Netflix", "Spotify"], "NETFLIX")).toBe(true);
    expect(matches("exact", ["Netflix", "Spotify"], "NETFLIX.COM")).toBe(false);
  });
});

describe("parseAnyOfPattern", () => {
  it("round-trips what the form compiles", () => {
    for (const condition of [
      { mode: "contains" as const, items: ["NETFLIX", "SPOTIFY"] },
      { mode: "exact" as const, items: ["AT&T", "Disney+", "A|B", "C.O.D. (x)", "50% $ off"] },
      { mode: "contains" as const, items: ["\\.+*?()|[]{}^$#&-~"] },
      { mode: "exact" as const, items: ["ends with $"] },
      { mode: "contains" as const, items: ["Café ☕"] },
    ]) {
      const pattern = compileAnyOfPattern(condition);
      expect(parseAnyOfPattern(pattern)).toEqual(condition);
      expect(compileAnyOfPattern(parseAnyOfPattern(pattern)!)).toBe(pattern);
    }
  });

  it("leaves any other regex a regex", () => {
    for (const pattern of [
      "NETFLIX|SPOTIFY",
      "(?:NETFLIX|SPOTIFY)", // case-sensitive: not what the list means
      "(?i)(NETFLIX|SPOTIFY)",
      "(?i)(?:NETFLIX|SPOT.FY)",
      "(?i)(?:NETFLIX|\\d+)",
      "(?i)^(?:NETFLIX|SPOTIFY)",
      "(?i)(?:NETFLIX|SPOTIFY)$",
      "(?i)(?:NETFLIX|)",
      "(?i)(?:NETFLIX| SPOTIFY)",
      "(?i)(?:NET(?:FLIX)|SPOTIFY)",
      "(?i)(?:NETFLIX\\)",
      NO_TEXT_CONDITION_PATTERN,
    ]) {
      expect(parseAnyOfPattern(pattern), pattern).toBeNull();
    }
  });
});

describe("textConditionDraft", () => {
  it("shows a payee-only rule with an empty text condition, never the placeholder", () => {
    expect(textConditionDraft({ pattern: NO_TEXT_CONDITION_PATTERN, matchType: "regex" })).toEqual({
      mode: "contains",
      pattern: "",
      list: "",
    });
  });

  it("shows a compiled list as the list again", () => {
    expect(
      textConditionDraft({ pattern: "(?i)^(?:AT\\&T|Disney\\+)$", matchType: "regex" }),
    ).toEqual({ mode: "any_exact", pattern: "", list: "AT&T\nDisney+" });
  });

  it("shows a hand-written regex and the plain match types as they are", () => {
    expect(textConditionDraft({ pattern: "^AMZN.*", matchType: "regex" })).toEqual({
      mode: "regex",
      pattern: "^AMZN.*",
      list: "",
    });
    expect(textConditionDraft({ pattern: "AMZN", matchType: "starts_with" })).toEqual({
      mode: "starts_with",
      pattern: "AMZN",
      list: "",
    });
    // The list shape stored under another match type is plain text.
    expect(textConditionDraft({ pattern: "(?i)(?:A|B)", matchType: "contains" }).mode).toBe(
      "contains",
    );
  });
});

describe("storedTextCondition", () => {
  it("stores a list as a regex", () => {
    expect(storedTextCondition({ mode: "any_contains", pattern: "", list: "A.B\nC" })).toEqual({
      pattern: "(?i)(?:A\\.B|C)",
      matchType: "regex",
    });
  });

  it("stores an empty condition as an empty contains pattern", () => {
    expect(storedTextCondition({ mode: "any_exact", pattern: "", list: " \n" })).toEqual({
      pattern: "",
      matchType: "contains",
    });
    expect(storedTextCondition({ mode: "regex", pattern: "  ", list: "" })).toEqual({
      pattern: "",
      matchType: "contains",
    });
  });

  it("stores a single text under its match type", () => {
    // As typed: a space around a fragment is part of what it matches.
    expect(storedTextCondition({ mode: "contains", pattern: " AMZN ", list: "ignored" })).toEqual({
      pattern: " AMZN ",
      matchType: "contains",
    });
  });

  it("gives back the stored pattern of an unchanged rule", () => {
    for (const rule of [
      { pattern: "(?i)^(?:AT\\&T|Disney\\+)$", matchType: "regex" as const },
      { pattern: "^AMZN.*", matchType: "regex" as const },
      { pattern: "AMZN", matchType: "starts_with" as const },
    ]) {
      expect(storedTextCondition(textConditionDraft(rule))).toEqual(rule);
    }
  });
});
