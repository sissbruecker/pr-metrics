/**
 * Shared constants for talking to the GitHub GraphQL API.
 *
 * The actual `fetch`-based client and queries live in later tasks; this module
 * holds the values that must be shared across every request.
 */

/** GitHub GraphQL v4 endpoint. */
export const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

/**
 * Mandatory `User-Agent` header for all GitHub requests — GitHub rejects
 * requests without one.
 */
export const USER_AGENT = "pr-stats";
