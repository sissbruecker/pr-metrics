/**
 * GitHub GraphQL API client.
 *
 * A thin `fetch`-based layer over GitHub's GraphQL v4 endpoint. It builds the
 * PR-search query, sends authenticated POST requests, surfaces GraphQL errors
 * (which arrive as `200 OK` with a top-level `errors` array), and offers
 * pagination helpers — including a date-windowed variant for backfills that
 * exceed GitHub's 1000-result search cap.
 *
 * This module is a pure fetch layer: it does not touch the database, compute
 * derived metrics, or pause on rate limits. Callers drive it and decide what to
 * do with the returned nodes and `rateLimit` info.
 */

/** GitHub GraphQL v4 endpoint. */
export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

/**
 * Mandatory `User-Agent` header for all GitHub requests — GitHub rejects
 * requests without one.
 */
export const USER_AGENT = "pr-stats";

/** Page size for the PR search. GitHub allows up to 100; 50 keeps node cost down. */
const SEARCH_PAGE_SIZE = 50;

/** GitHub's search API never returns more than this many results for one query. */
export const SEARCH_RESULT_CAP = 1000;

// --- Response & node types ---------------------------------------------------

/** GraphQL `rateLimit` selection — consumed by the rate-limit pause logic. */
export interface RateLimit {
  /** Remaining points in the current window. */
  remaining: number;
  /** ISO timestamp when the window resets. */
  resetAt: string;
  /** Point cost of the query that returned this object. */
  cost: number;
}

/** A single `ReadyForReviewEvent` / `ConvertToDraftEvent` timeline node. */
export interface TimelineEventNode {
  __typename: string;
  createdAt: string;
}

/**
 * A pull request node as selected by {@link buildListQuery}. Shapes mirror the
 * GraphQL selection exactly; nullable fields are nullable here too.
 */
export interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  body: string | null;
  author: { login: string } | null;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  isDraft: boolean;
  merged: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  milestone: { title: string } | null;
  commits: { totalCount: number };
  reviews: { totalCount: number; nodes: Array<{ submittedAt: string | null }> };
  comments: { totalCount: number };
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login: string } | null }>;
  };
  /**
   * Only `ReadyForReviewEvent` / `ConvertToDraftEvent` nodes are selected.
   * NOTE: `timelineItems.totalCount` ignores the `itemTypes` filter, so it is
   * intentionally NOT selected — rely only on `nodes`.
   */
  timelineItems: { nodes: TimelineEventNode[] };
}

/** `pageInfo` selection for cursor-based pagination. */
export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** One page of search results plus the rate-limit snapshot for the request. */
export interface SearchPage {
  nodes: PullRequestNode[];
  pageInfo: PageInfo;
  rateLimit: RateLimit;
}

/** Shape of the GraphQL response document for the list query. */
interface ListQueryData {
  rateLimit: RateLimit;
  search: {
    pageInfo: PageInfo;
    nodes: PullRequestNode[];
  };
}

interface GraphQLError {
  message: string;
  type?: string;
  path?: Array<string | number>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/** Thrown when a GraphQL request fails — either by HTTP status or by `errors`. */
export class GitHubGraphQLError extends Error {
  /** The raw GraphQL `errors` array, if the failure came back as `200 OK`. */
  readonly errors?: GraphQLError[];
  /** The HTTP status, if the failure was a transport-level error. */
  readonly status?: number;

  constructor(message: string, options?: { errors?: GraphQLError[]; status?: number }) {
    super(message);
    this.name = "GitHubGraphQLError";
    this.errors = options?.errors;
    this.status = options?.status;
  }
}

// --- Query building ----------------------------------------------------------

/**
 * The per-PR field selection, shared by every search query. Kept as a constant
 * so the {@link PullRequestNode} type and the GraphQL selection stay in sync.
 */
const PR_FIELDS = `
    number
    title
    url
    body
    author { login }
    createdAt
    mergedAt
    closedAt
    updatedAt
    isDraft
    merged
    baseRefName
    headRefName
    additions
    deletions
    changedFiles
    milestone { title }
    commits { totalCount }
    reviews(first: 1) { totalCount nodes { submittedAt } }
    comments { totalCount }
    labels(first: 20) { nodes { name } }
    assignees(first: 10) { nodes { login } }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
    timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
      nodes {
        __typename
        ... on ReadyForReviewEvent { createdAt }
        ... on ConvertToDraftEvent { createdAt }
      }
    }`;

/**
 * Build the paginated list query. The search string and cursor are passed as
 * variables (`$q`, `$cursor`) — they are never interpolated into the document.
 */
export function buildListQuery(): string {
  return `query($q: String!, $cursor: String) {
  rateLimit { remaining resetAt cost }
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {${PR_FIELDS}
      }
    }
  }
}`;
}

/**
 * Build the search query *string* (the value of the `$q` variable) for all
 * merged PRs in a repo merged on/after `since` (an ISO date or datetime).
 *
 * Results are sorted ascending by creation time: search cannot sort by
 * `merged_at`, so creation order is the stable cursor ordering.
 */
export function buildSearchQueryString(owner: string, name: string, since: string): string {
  return `repo:${owner}/${name} is:pr is:merged merged:>=${since} sort:created-asc`;
}

/**
 * Build the search query *string* restricted to PRs merged within a closed
 * `[start, end]` window. Used to slice a large backfill into sub-1000-result
 * windows that each fit under the search cap.
 */
export function buildWindowedSearchQueryString(
  owner: string,
  name: string,
  start: string,
  end: string,
): string {
  return `repo:${owner}/${name} is:pr is:merged merged:${start}..${end} sort:created-asc`;
}

// --- Client ------------------------------------------------------------------

/** Options for {@link GitHubClient}. */
export interface GitHubClientOptions {
  /** Override the GraphQL endpoint (e.g. for GitHub Enterprise or testing). */
  endpoint?: string;
  /** Override the `fetch` implementation (e.g. for testing). */
  fetch?: typeof fetch;
  /** Override the `User-Agent` header. */
  userAgent?: string;
}

/**
 * A minimal GitHub GraphQL client. Holds the auth token and exposes a raw
 * `request` method plus PR-search-specific helpers.
 */
export class GitHubClient {
  private readonly token: string;
  private readonly endpoint: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, options: GitHubClientOptions = {}) {
    if (!token) {
      throw new Error("GitHubClient requires a non-empty token.");
    }
    this.token = token;
    this.endpoint = options.endpoint ?? GITHUB_GRAPHQL_ENDPOINT;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Send one GraphQL request and return the typed `data`.
   *
   * Throws {@link GitHubGraphQLError} on a non-OK HTTP status OR on a `200 OK`
   * response that carries a top-level `errors` array (GitHub returns business
   * errors this way), so callers never have to inspect both channels.
   */
  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": this.userAgent,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // Non-2xx — surface the status and any body we can read for context.
      const text = await response.text().catch(() => "");
      throw new GitHubGraphQLError(
        `GitHub GraphQL request failed with HTTP ${response.status} ${response.statusText}` +
          (text ? `: ${text}` : ""),
        { status: response.status },
      );
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    // GraphQL errors come back as 200 OK — check on every response.
    if (json.errors && json.errors.length > 0) {
      const summary = json.errors.map((e) => e.message).join("; ");
      throw new GitHubGraphQLError(`GitHub GraphQL error: ${summary}`, {
        errors: json.errors,
      });
    }

    if (json.data === undefined) {
      throw new GitHubGraphQLError("GitHub GraphQL response contained no data.");
    }

    return json.data;
  }

  /**
   * Fetch a single page of merged PRs for the given search query string.
   * Pass `cursor` (a previous page's `endCursor`) to continue pagination.
   */
  async fetchSearchPage(searchQuery: string, cursor: string | null = null): Promise<SearchPage> {
    const data = await this.request<ListQueryData>(buildListQuery(), {
      q: searchQuery,
      cursor,
    });
    return {
      nodes: data.search.nodes,
      pageInfo: data.search.pageInfo,
      rateLimit: data.rateLimit,
    };
  }

  /**
   * Page through *every* result for a single search query string, yielding one
   * {@link SearchPage} at a time. The caller can inspect `rateLimit` on each
   * page (e.g. to decide whether to pause) and persist nodes incrementally.
   *
   * Note: a single search query is capped at {@link SEARCH_RESULT_CAP} results.
   * For backfills that exceed that, use {@link paginateWindowed} instead.
   */
  async *paginateSearch(searchQuery: string): AsyncGenerator<SearchPage> {
    let cursor: string | null = null;
    do {
      const page: SearchPage = await this.fetchSearchPage(searchQuery, cursor);
      yield page;
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor !== null);
  }

  /**
   * Page through merged PRs across a sequence of date windows, yielding every
   * page in order. This works around the {@link SEARCH_RESULT_CAP}: each window
   * is a `[start, end]` range that should hold fewer than the cap, and each is
   * fully paginated before moving to the next.
   *
   * Windows are supplied by the caller (e.g. the sync engine, which knows the
   * backfill start and can split a range into months/weeks). Each window is an
   * ISO date or datetime; ranges are inclusive on both ends.
   */
  async *paginateWindowed(
    owner: string,
    name: string,
    windows: Iterable<{ start: string; end: string }>,
  ): AsyncGenerator<SearchPage> {
    for (const { start, end } of windows) {
      const q = buildWindowedSearchQueryString(owner, name, start, end);
      yield* this.paginateSearch(q);
    }
  }
}
