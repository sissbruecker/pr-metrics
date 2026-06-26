/**
 * Pull request categorization.
 *
 * Pure functions — no database access, no network. A PR's category is derived
 * at query time from its raw `title`; it is never stored as a column. Because
 * categorization lives entirely in code, changing the rules re-categorizes all
 * existing PRs with no re-sync.
 *
 * A rule maps a conventional-commit-style title prefix to a category. Rules are
 * evaluated in order and the FIRST matching rule wins. A title that matches no
 * rule is "Uncategorized".
 *
 * Matching decisions (deliberate, applied consistently):
 * - Leading/trailing whitespace is trimmed from the title before matching, so
 *   `"  fix: x"` categorizes the same as `"fix: x"`.
 * - Prefix matching is case-insensitive. Conventional-commit prefixes are
 *   conventionally lowercase, but real-world titles vary (e.g. `"Fix: ..."`),
 *   and treating them alike is the least surprising behavior.
 * - Each prefix includes its trailing colon (e.g. `"fix:"`). A title matches a
 *   rule when (after trimming) it starts with the prefix. The trailing colon
 *   keeps prefixes from over-matching: `"fixup: x"` does NOT start with
 *   `"fix:"`, so it falls through to Uncategorized rather than mapping to Fix.
 */

/** The set of categories a PR can be assigned, including the fallback. */
export type Category =
  | "Fix"
  | "Feature"
  | "Refactor"
  | "Docs"
  | "Chore"
  | "Test"
  | "Uncategorized";

/**
 * Canonical ordered list of all known categories, with "Uncategorized" last.
 * The stats/UI layers use this as the display ordering and to ensure every
 * category (including Uncategorized) is always represented.
 */
export const CATEGORIES: readonly Category[] = [
  "Fix",
  "Feature",
  "Refactor",
  "Docs",
  "Chore",
  "Test",
  "Uncategorized",
] as const;

/** The category assigned when no rule matches. */
export const UNCATEGORIZED: Category = "Uncategorized";

/** A single categorization rule: a title prefix mapped to a category. */
export interface CategoryRule {
  /** Title prefix to match, including its trailing colon (e.g. `"fix:"`). */
  readonly prefix: string;
  /** Category assigned when the prefix matches. */
  readonly category: Category;
}

/**
 * The default rule set, in evaluation order. First match wins, so order is
 * significant. Note `feat:` and `feature:` both map to "Feature".
 */
export const DEFAULT_RULES: readonly CategoryRule[] = [
  { prefix: "fix:", category: "Fix" },
  { prefix: "feat:", category: "Feature" },
  { prefix: "feature:", category: "Feature" },
  { prefix: "refactor:", category: "Refactor" },
  { prefix: "docs:", category: "Docs" },
  { prefix: "chore:", category: "Chore" },
  { prefix: "test:", category: "Test" },
] as const;

/**
 * Categorize a PR by its title. Applies the given rules in order and returns
 * the category of the first rule whose prefix matches; returns "Uncategorized"
 * when none match. Matching is case-insensitive and ignores surrounding
 * whitespace (see module docs).
 */
export function categorize(
  title: string,
  rules: readonly CategoryRule[] = DEFAULT_RULES,
): Category {
  const normalized = title.trim().toLowerCase();
  for (const rule of rules) {
    if (normalized.startsWith(rule.prefix.toLowerCase())) {
      return rule.category;
    }
  }
  return UNCATEGORIZED;
}
