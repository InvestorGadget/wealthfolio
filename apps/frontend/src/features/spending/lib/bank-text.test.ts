import { describe, expect, it } from "vitest";

import { getDifferingBankText, getTransactionTitle } from "./bank-text";

describe("getTransactionTitle", () => {
  it("prefers the user's notes and falls back to the imported description", () => {
    expect(
      getTransactionTitle({ importedDescription: "TESCO STORES 3301", notes: "Weekly shop" }),
    ).toBe("Weekly shop");
    expect(getTransactionTitle({ importedDescription: "TESCO STORES 3301", notes: " " })).toBe(
      "TESCO STORES 3301",
    );
    expect(getTransactionTitle({ importedDescription: null, notes: "Lunch" })).toBe("Lunch");
    expect(getTransactionTitle({ importedDescription: "  ", notes: "" })).toBeUndefined();
    expect(getTransactionTitle({})).toBeUndefined();
  });
});

describe("getDifferingBankText", () => {
  it("returns the imported description only when the notes say something else", () => {
    expect(
      getDifferingBankText({ importedDescription: "TESCO STORES 3301", notes: "Weekly shop" }),
    ).toBe("TESCO STORES 3301");
    expect(
      getDifferingBankText({
        importedDescription: "TESCO STORES 3301",
        notes: " TESCO STORES 3301",
      }),
    ).toBeUndefined();
    // Blank notes: the description is already the title.
    expect(
      getDifferingBankText({ importedDescription: "TESCO STORES 3301", notes: "" }),
    ).toBeUndefined();
    // A manual entry has no bank text to show.
    expect(getDifferingBankText({ importedDescription: null, notes: "Lunch" })).toBeUndefined();
    expect(getDifferingBankText({ importedDescription: " ", notes: "Lunch" })).toBeUndefined();
  });
});
