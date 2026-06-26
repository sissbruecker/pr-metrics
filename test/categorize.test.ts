import { describe, expect, test } from "bun:test";
import {
  categorize,
  CATEGORIES,
  DEFAULT_RULES,
  UNCATEGORIZED,
  type CategoryRule,
} from "../src/categorize.ts";

describe("categorize — default rules", () => {
  test("every default prefix maps to its expected category", () => {
    expect(categorize("fix: a bug")).toBe("Fix");
    expect(categorize("feat: a thing")).toBe("Feature");
    expect(categorize("feature: a thing")).toBe("Feature");
    expect(categorize("refactor: cleanup")).toBe("Refactor");
    expect(categorize("docs: readme")).toBe("Docs");
    expect(categorize("chore: deps")).toBe("Chore");
    expect(categorize("test: add coverage")).toBe("Test");
  });

  test("feat: and feature: both map to Feature", () => {
    expect(categorize("feat: x")).toBe("Feature");
    expect(categorize("feature: x")).toBe("Feature");
  });

  test("no matching prefix → Uncategorized", () => {
    expect(categorize("just a regular title")).toBe(UNCATEGORIZED);
    expect(categorize("Bump version to 1.2.3")).toBe("Uncategorized");
  });

  test("trailing-colon guard: fixup: → Uncategorized (does not match fix:)", () => {
    expect(categorize("fixup: squashed commit")).toBe(UNCATEGORIZED);
  });

  test("case-insensitive matching", () => {
    expect(categorize("Fix: capitalized")).toBe("Fix");
    expect(categorize("FEAT: shouting")).toBe("Feature");
  });

  test("leading/trailing whitespace is trimmed before matching", () => {
    expect(categorize("  fix: x  ")).toBe("Fix");
    expect(categorize("\tdocs: y")).toBe("Docs");
  });
});

describe("categorize — first-match-wins ordering", () => {
  test("first matching rule wins with a custom ordered rule set", () => {
    // Two rules whose prefixes both match "feat-x:". Order decides the winner.
    const rules: CategoryRule[] = [
      { prefix: "feat", category: "Feature" },
      { prefix: "feat-x", category: "Fix" },
    ];
    // "feat-x: y" starts with "feat" first → Feature, not Fix.
    expect(categorize("feat-x: y", rules)).toBe("Feature");

    // Reverse the order: the more specific rule now comes first.
    const reversed: CategoryRule[] = [
      { prefix: "feat-x", category: "Fix" },
      { prefix: "feat", category: "Feature" },
    ];
    expect(categorize("feat-x: y", reversed)).toBe("Fix");
  });

  test("default ordering: feat: precedes feature: but they share a category", () => {
    // Documents that DEFAULT_RULES order is feat: before feature:.
    expect(DEFAULT_RULES[1]!.prefix).toBe("feat:");
    expect(DEFAULT_RULES[2]!.prefix).toBe("feature:");
  });
});

describe("CATEGORIES constant", () => {
  test("Uncategorized is the last category", () => {
    expect(CATEGORIES[CATEGORIES.length - 1]).toBe("Uncategorized");
  });
});
