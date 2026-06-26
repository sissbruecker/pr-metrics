/**
 * Time-to-merge (TTM) computation.
 *
 * Pure functions — no database access, no network. Given a pull request's
 * timeline of draft/ready transitions (plus its create/merge timestamps), this
 * module derives the start point of the "time to merge" measurement and the
 * resulting duration.
 *
 * Definition: `ttm_seconds = merged_at − ready_for_review_at`, in whole
 * wall-clock seconds.
 *
 * Determining `ready_for_review_at`:
 * - Never a draft (no transition nodes) → `created_at`.
 * - Opened as draft, marked ready once → that `ready_for_review` timestamp.
 * - Toggled draft ↔ ready multiple times → the LAST ready-for-review
 *   transition that occurs at/before the merge.
 * - Merged while still a draft (the last transition before merge is a
 *   convert-to-draft, or `isDraft` is true at merge) → no usable ready event,
 *   fall back to `created_at`.
 * - Draft history unavailable/missing → fall back to `created_at` and flag the
 *   PR as approximate.
 *
 * The raw transitions are also returned so they can be persisted verbatim,
 * letting the TTM definition change later without re-syncing.
 */

import type { PullRequestNode, TimelineEventNode } from "./github.ts";

/** GraphQL typename for a "marked ready for review" transition. */
const READY_FOR_REVIEW_TYPENAME = "ReadyForReviewEvent";
/** GraphQL typename for a "converted to draft" transition. */
const CONVERT_TO_DRAFT_TYPENAME = "ConvertToDraftEvent";

/** A normalized draft/ready transition kind. */
export type DraftEventType = "ready_for_review" | "convert_to_draft";

/**
 * A single normalized draft/ready transition. Persisted verbatim (as a JSON
 * array) in the `draft_events` column so the TTM definition can evolve without
 * re-syncing.
 */
export interface DraftEvent {
  /** Normalized transition kind. */
  type: DraftEventType;
  /** ISO 8601 timestamp of the transition. */
  at: string;
}

/**
 * The narrow input the TTM computation needs. {@link PullRequestNode} is
 * structurally assignable to this, so callers can pass a full node directly.
 */
export interface TtmInput {
  createdAt: string;
  mergedAt: string | null;
  isDraft: boolean;
  reviews: { nodes: Array<{ submittedAt: string | null }> };
  /** Only ready-for-review / convert-to-draft nodes; order is not trusted. */
  timelineItems: { nodes: TimelineEventNode[] };
}

/**
 * The structured result of the TTM computation. Field names line up with the
 * `pull_requests` columns the sync engine persists. `draft_events` is returned
 * as a parsed array — the persistence layer is responsible for JSON-stringifying
 * it — not pre-serialized here.
 */
export interface TtmResult {
  /** Computed start point for the measurement (ISO timestamp). */
  ready_for_review_at: string;
  /**
   * Time to merge in whole seconds, or `null` when the PR is not merged
   * (`mergedAt` is null). In practice these are always merged PRs.
   */
  ttm_seconds: number | null;
  /** `0`/`1` — whether the TTM is an approximation (draft history missing). */
  ttm_is_approximate: 0 | 1;
  /** `0`/`1` — whether the PR was ever in draft state. */
  was_ever_draft: 0 | 1;
  /** First review's `submittedAt`, or `null` when there are no reviews. */
  first_review_at: string | null;
  /** Raw normalized transitions, in chronological order. */
  draft_events: DraftEvent[];
}

/**
 * Normalize the raw timeline nodes into {@link DraftEvent}s, sorted into
 * chronological order. Input order is not trusted, so we sort by timestamp.
 * Unknown typenames are dropped (the query only selects the two relevant ones,
 * but this keeps the parser defensive).
 */
export function parseDraftEvents(nodes: TimelineEventNode[]): DraftEvent[] {
  const events: DraftEvent[] = [];
  for (const node of nodes) {
    const type = normalizeEventType(node.__typename);
    if (type === null) {
      continue;
    }
    events.push({ type, at: node.createdAt });
  }
  // Stable chronological sort — don't trust the order GitHub returned.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

/** Map a GraphQL typename to a normalized transition kind, or `null`. */
function normalizeEventType(typename: string): DraftEventType | null {
  switch (typename) {
    case READY_FOR_REVIEW_TYPENAME:
      return "ready_for_review";
    case CONVERT_TO_DRAFT_TYPENAME:
      return "convert_to_draft";
    default:
      return null;
  }
}

/**
 * Derive the `ready_for_review_at` start point from the (already chronological)
 * transitions, given the PR's `createdAt`, `mergedAt`, and draft-at-merge flag.
 *
 * Returns `null` only to signal "no usable ready event" so the caller can fall
 * back to `created_at`; in every case the caller resolves a concrete timestamp.
 *
 * Boundary: a ready event whose timestamp equals `mergedAt` is considered to be
 * "at/before merge" and is eligible (inclusive upper bound).
 */
export function deriveReadyForReviewAt(
  events: DraftEvent[],
  createdAt: string,
  mergedAt: string | null,
  isDraftAtMerge: boolean,
): string {
  // Never a draft: no transitions at all → measure from creation.
  if (events.length === 0) {
    return createdAt;
  }

  // Consider only transitions at/before the merge. If the PR is not merged,
  // there is no merge boundary, so consider everything.
  const mergeMs = mergedAt === null ? null : Date.parse(mergedAt);
  const inWindow =
    mergeMs === null ? events : events.filter((e) => Date.parse(e.at) <= mergeMs);

  // If the PR is still a draft at merge, the merge happened while in draft
  // (e.g. an admin merge) — there is no usable ready event regardless of
  // history, so fall back to creation.
  if (isDraftAtMerge) {
    return createdAt;
  }

  // The last in-window transition determines the state going into the merge.
  const last = inWindow.length > 0 ? inWindow[inWindow.length - 1] : undefined;

  // Last transition is convert-to-draft → merged while in draft → fall back.
  if (last !== undefined && last.type === "convert_to_draft") {
    return createdAt;
  }

  // Otherwise use the LAST ready-for-review transition in the window.
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const event = inWindow[i];
    if (event !== undefined && event.type === "ready_for_review") {
      return event.at;
    }
  }

  // No ready-for-review transition before merge (e.g. all transitions happened
  // after the merge boundary, or only convert-to-draft exists) → fall back.
  return createdAt;
}

/**
 * Compute the full TTM result for a pull request.
 *
 * Pass a {@link PullRequestNode} (or any {@link TtmInput}-shaped object). The
 * result's field names align with the `pull_requests` columns; `draft_events`
 * is returned unserialized.
 */
export function computeTtm(pr: TtmInput): TtmResult {
  const events = parseDraftEvents(pr.timelineItems.nodes);
  const wasEverDraft: 0 | 1 = events.length > 0 ? 1 : 0;

  const readyForReviewAt = deriveReadyForReviewAt(
    events,
    pr.createdAt,
    pr.mergedAt,
    pr.isDraft,
  );

  const ttmSeconds = computeTtmSeconds(readyForReviewAt, pr.mergedAt);

  // Draft history is present (we parsed transitions from the node), but it is
  // only *usable* if every transition timestamp parses. An unparseable
  // timestamp gets silently dropped from the merge-window filter, which quietly
  // collapses the start point back to created_at — so the result is no longer
  // exact and must be flagged. This is the node-derivable "draft history
  // present but unusable" case. The broader "the timeline could not be
  // retrieved at all" case is not detectable here (we only see the nodes we
  // were given) and is the sync engine's responsibility to flag.
  const draftHistoryUnusable =
    events.length > 0 && events.some((e) => Number.isNaN(Date.parse(e.at)));
  const ttmIsApproximate: 0 | 1 = draftHistoryUnusable ? 1 : 0;

  // first_review_at: the first review's submittedAt (the query selects only the
  // earliest review), null when there are no reviews. Unused by TTM.
  const firstReview = pr.reviews.nodes[0];
  const firstReviewAt = firstReview?.submittedAt ?? null;

  return {
    ready_for_review_at: readyForReviewAt,
    ttm_seconds: ttmSeconds,
    ttm_is_approximate: ttmIsApproximate,
    was_ever_draft: wasEverDraft,
    first_review_at: firstReviewAt,
    draft_events: events,
  };
}

/**
 * Compute whole-second TTM from `ready_for_review_at` to `mergedAt`. Returns
 * `null` when the PR is not merged. Timestamps are whole-second ISO values, so
 * the result is integral regardless; we floor to be deliberate and never emit a
 * fractional second.
 */
export function computeTtmSeconds(
  readyForReviewAt: string,
  mergedAt: string | null,
): number | null {
  if (mergedAt === null) {
    return null;
  }
  const startMs = Date.parse(readyForReviewAt);
  const mergeMs = Date.parse(mergedAt);
  if (Number.isNaN(startMs) || Number.isNaN(mergeMs)) {
    return null;
  }
  return Math.floor((mergeMs - startMs) / 1000);
}
