import { describe, expect, test } from "bun:test";
import {
  computeTtm,
  computeTtmSeconds,
  deriveReadyForReviewAt,
  parseDraftEvents,
  type DraftEvent,
  type TtmInput,
} from "../src/ttm.ts";
import type { TimelineEventNode } from "../src/github.ts";

/** Build a minimal TtmInput for the TTM computation. */
function makeInput(over: Partial<TtmInput> = {}): TtmInput {
  return {
    createdAt: "2026-01-01T00:00:00Z",
    mergedAt: "2026-01-02T00:00:00Z",
    isDraft: false,
    reviews: { nodes: [] },
    timelineItems: { nodes: [] },
    ...over,
  };
}

/** Build a timeline node. */
function node(typename: string, createdAt: string): TimelineEventNode {
  return { __typename: typename, createdAt };
}

const READY = "ReadyForReviewEvent";
const DRAFT = "ConvertToDraftEvent";

describe("TTM start-point logic (all five cases)", () => {
  test("never a draft → ready_for_review_at === createdAt", () => {
    const input = makeInput({
      createdAt: "2026-03-01T10:00:00Z",
      mergedAt: "2026-03-02T10:00:00Z",
      timelineItems: { nodes: [] },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T10:00:00Z");
    expect(result.was_ever_draft).toBe(0);
    expect(result.ttm_is_approximate).toBe(0);
  });

  test("opened as draft, marked ready once → start = the ReadyForReviewEvent timestamp", () => {
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      timelineItems: { nodes: [node(READY, "2026-03-02T12:00:00Z")] },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-02T12:00:00Z");
    expect(result.was_ever_draft).toBe(1);
    expect(result.ttm_is_approximate).toBe(0);
  });

  test("toggled multiple times → start = LAST ready transition before merge (sorted app-side, post-merge excluded)", () => {
    const merged = "2026-03-10T00:00:00Z";
    // Fed deliberately OUT OF ORDER to prove app-side chronological sorting.
    // Includes a ready event AFTER mergedAt that must be excluded.
    const nodes = [
      node(READY, "2026-03-08T00:00:00Z"), // last ready BEFORE merge → expected
      node(DRAFT, "2026-03-03T00:00:00Z"),
      node(READY, "2026-03-02T00:00:00Z"),
      node(READY, "2026-03-12T00:00:00Z"), // AFTER merge → must be excluded
      node(DRAFT, "2026-03-05T00:00:00Z"),
      node(READY, "2026-03-06T00:00:00Z"),
    ];
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: merged,
      timelineItems: { nodes },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-08T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
    expect(result.ttm_is_approximate).toBe(0);
  });

  test("merged while still draft (a): isDraft true → fall back to createdAt", () => {
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      isDraft: true,
      // Even with a ready event, draft-at-merge forces the fallback.
      timelineItems: { nodes: [node(READY, "2026-03-02T00:00:00Z")] },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("merged while still draft (b): last in-window transition is ConvertToDraftEvent → fall back to createdAt", () => {
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-10T00:00:00Z",
      isDraft: false,
      timelineItems: {
        nodes: [
          node(READY, "2026-03-02T00:00:00Z"),
          node(DRAFT, "2026-03-08T00:00:00Z"), // last before merge → in draft
        ],
      },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("missing/unusable history: unparseable transition timestamp → fall back to createdAt AND approximate", () => {
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      timelineItems: { nodes: [node(READY, "not-a-timestamp")] },
    });
    const result = computeTtm(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.ttm_is_approximate).toBe(1);
    expect(result.was_ever_draft).toBe(1);
  });
});

describe("TTM seconds & first_review_at", () => {
  test("ttm_seconds === merged_at − ready_for_review_at (integer) for a normal case", () => {
    const input = makeInput({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-02T00:00:00Z", // exactly 1 day later
      timelineItems: { nodes: [] },
    });
    const result = computeTtm(input);
    expect(result.ttm_seconds).toBe(86400);
    expect(Number.isInteger(result.ttm_seconds)).toBe(true);
  });

  test("computeTtmSeconds: null mergedAt → null; unparseable → null", () => {
    expect(computeTtmSeconds("2026-03-01T00:00:00Z", null)).toBeNull();
    expect(computeTtmSeconds("nope", "2026-03-02T00:00:00Z")).toBeNull();
    expect(computeTtmSeconds("2026-03-01T00:00:00Z", "2026-03-01T00:00:30Z")).toBe(30);
  });

  test("first_review_at comes from reviews.nodes[0].submittedAt", () => {
    const withReview = computeTtm(
      makeInput({ reviews: { nodes: [{ submittedAt: "2026-03-02T08:00:00Z" }] } }),
    );
    expect(withReview.first_review_at).toBe("2026-03-02T08:00:00Z");
  });

  test("first_review_at is null when there are no reviews", () => {
    const noReview = computeTtm(makeInput({ reviews: { nodes: [] } }));
    expect(noReview.first_review_at).toBeNull();
  });
});

describe("deriveReadyForReviewAt boundary & edge cases", () => {
  test("ready event exactly at mergedAt is eligible (inclusive upper bound)", () => {
    const events: DraftEvent[] = [{ type: "ready_for_review", at: "2026-03-05T00:00:00Z" }];
    const start = deriveReadyForReviewAt(events, "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", false);
    expect(start).toBe("2026-03-05T00:00:00Z");
  });

  test("empty events → createdAt", () => {
    expect(deriveReadyForReviewAt([], "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", false)).toBe(
      "2026-03-01T00:00:00Z",
    );
  });

  test("not merged (null mergedAt) → considers all events, last ready wins", () => {
    const events: DraftEvent[] = [
      { type: "ready_for_review", at: "2026-03-02T00:00:00Z" },
      { type: "convert_to_draft", at: "2026-03-03T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-04T00:00:00Z" },
    ];
    expect(deriveReadyForReviewAt(events, "2026-03-01T00:00:00Z", null, false)).toBe(
      "2026-03-04T00:00:00Z",
    );
  });
});

describe("parseDraftEvents (timeline parsing — nodes-only)", () => {
  test("empty nodes → no events (drives never-draft regardless of any totalCount)", () => {
    // The type does not even carry totalCount; behavior is driven purely by nodes.
    expect(parseDraftEvents([])).toEqual([]);
    const result = computeTtm(
      makeInput({ createdAt: "2026-01-01T00:00:00Z", timelineItems: { nodes: [] } }),
    );
    expect(result.was_ever_draft).toBe(0);
    expect(result.ready_for_review_at).toBe("2026-01-01T00:00:00Z");
  });

  test("normalizes __typename → type and sorts chronologically", () => {
    const events = parseDraftEvents([
      node(READY, "2026-03-05T00:00:00Z"),
      node(DRAFT, "2026-03-01T00:00:00Z"),
      node(READY, "2026-03-03T00:00:00Z"),
    ]);
    expect(events).toEqual([
      { type: "convert_to_draft", at: "2026-03-01T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-03T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-05T00:00:00Z" },
    ]);
  });

  test("drops unknown typenames", () => {
    const events = parseDraftEvents([
      node("SomeOtherEvent", "2026-03-02T00:00:00Z"),
      node(READY, "2026-03-01T00:00:00Z"),
      node("MergedEvent", "2026-03-03T00:00:00Z"),
    ]);
    expect(events).toEqual([{ type: "ready_for_review", at: "2026-03-01T00:00:00Z" }]);
  });
});
