/**
 * Shapes of what `gh` prints with `--json`, passed through by
 * `src-tauri/src/commands/github.rs`. Only the fields the UI reads are typed.
 */

export interface GhUser {
  login: string
  name: string | null
  avatarUrl: string
  url: string
}

export interface GhStatus {
  installed: boolean
  version: string | null
  brewAvailable: boolean
  user: GhUser | null
}

export type SetupEvent = { type: "line"; text: string } | { type: "code"; code: string; url: string }

export interface GhRepo {
  nameWithOwner: string
  url: string
  defaultBranchRef: { name: string } | null
  viewerPermission: "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | null
  isFork: boolean
}

export interface GhActor {
  login: string
  name?: string
  is_bot?: boolean
}

export type PrState = "OPEN" | "CLOSED" | "MERGED"
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null

/** One entry of `statusCheckRollup`: a check run or an old-style commit status. */
export type GhCheck =
  | {
      __typename: "CheckRun"
      name: string
      workflowName?: string
      status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "WAITING" | "PENDING" | "REQUESTED"
      conclusion: "SUCCESS" | "FAILURE" | "NEUTRAL" | "CANCELLED" | "SKIPPED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STALE" | ""
      detailsUrl: string
      startedAt: string
      completedAt: string
    }
  | {
      __typename: "StatusContext"
      context: string
      state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED"
      targetUrl: string
      startedAt?: string
    }

export interface GhLabel {
  name: string
  color: string
}

export interface GhComment {
  id: string
  author: GhActor
  body: string
  createdAt: string
  url?: string
}

export interface GhReview {
  id: string
  author: GhActor
  body: string
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  submittedAt: string
}

/** Line comments on one place in the diff, from GraphQL `reviewThreads`. */
export interface GhReviewThread {
  id: string
  path: string
  /** Null once outdated; then `originalLine` is where it was left. */
  line: number | null
  originalLine: number | null
  startLine: number | null
  originalStartLine: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: { nodes: Array<{ id: string; author: GhActor | null; body: string; createdAt: string; diffHunk: string; url: string }> }
}

export interface PrSummary {
  number: number
  title: string
  author: GhActor
  headRefName: string
  baseRefName: string
  isDraft: boolean
  state: PrState
  createdAt: string
  updatedAt: string
  reviewDecision: ReviewDecision
  statusCheckRollup: GhCheck[]
  additions: number
  deletions: number
  labels: GhLabel[]
  url: string
  comments: GhComment[]
}

export interface PrDetail extends PrSummary {
  body: string
  mergedAt: string | null
  closedAt: string | null
  changedFiles: number
  reviews: GhReview[]
  reviewThreads: GhReviewThread[]
  files: Array<{ path: string; additions: number; deletions: number; changeType: string }>
  commits: Array<{ oid: string; messageHeadline: string; authoredDate: string; authors: GhActor[] }>
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus: string
  reviewRequests: Array<{ login?: string; name?: string; slug?: string }>
}

export interface BranchPr {
  number: number
  title: string
  state: PrState
  isDraft: boolean
  url: string
  statusCheckRollup: GhCheck[]
  reviewDecision: ReviewDecision
}

export type PrFilter = "open" | "mine" | "review" | "merged" | "closed"

/** Which list the tracker shows: pull requests or issues, from every repository. */
export type TrackerKind = "prs" | "issues"
export type TrackerState = "open" | "merged" | "closed"
/** How the signed-in user is involved; `any` needs a repository. */
export type Involvement = "involves" | "author" | "assignee" | "review-requested" | "mentions" | "any"

export interface SearchFilters {
  state: TrackerState
  involvement: Involvement
  repo: string | null
  label: string | null
  /** `YYYY-MM-DD`: updated on or after. */
  updatedSince: string | null
  query: string | null
}

/** One row of `gh search prs|issues`. Its `state` is lower case, unlike `gh pr`. */
export interface SearchItem {
  number: number
  title: string
  state: "open" | "closed" | "merged"
  /** Pull requests only. */
  isDraft?: boolean
  repository: { name: string; nameWithOwner: string }
  labels: GhLabel[]
  author: GhActor
  createdAt: string
  updatedAt: string
  commentsCount: number
  url: string
}

export interface GhRepoRef {
  nameWithOwner: string
  private: boolean
  archived: boolean
}

export type IssueState = "OPEN" | "CLOSED"
export type IssueStateReason = "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "" | null

export interface IssueDetail {
  number: number
  title: string
  body: string
  author: GhActor
  state: IssueState
  stateReason: IssueStateReason
  labels: GhLabel[]
  assignees: GhActor[]
  comments: GhComment[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  url: string
}

/** An attachment downloaded into the app's cache. */
export interface GhAsset {
  path: string
  contentType: string
  name: string
  size: number
}

export type IssueStateChange = "close" | "close-not-planned" | "reopen"
export type MergeMethod = "squash" | "merge" | "rebase"
export type ReviewAction = "approve" | "request-changes" | "comment"
export type PrStateChange = "close" | "reopen" | "ready" | "draft"

export type GhErrorKind = "not-installed" | "not-signed-in" | "other"

const GH_ERROR = /^gh:(not-installed|not-signed-in|other): /

/** The kind of a `gh` failure, from the `gh:<kind>: ` prefix the Rust side adds. */
export function ghErrorKind(error: unknown): GhErrorKind | null {
  const match = typeof error === "string" ? GH_ERROR.exec(error) : null
  return match ? (match[1] as GhErrorKind) : null
}

/** A GitHub user's avatar by login; works for anyone, bots included. */
export function avatarUrl(login: string, size = 40): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}?s=${size * 2}`
}

export type CheckState = "pass" | "fail" | "pending" | "none"

export function checkState(check: GhCheck): Exclude<CheckState, "none"> {
  if (check.__typename === "StatusContext") {
    return check.state === "SUCCESS" ? "pass" : check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "fail"
  }
  if (check.status !== "COMPLETED") return "pending"
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion) ? "pass" : "fail"
}

/** The checks rolled up: any failure fails, then anything running is pending. */
export function checksSummary(checks: GhCheck[] | null | undefined): { state: CheckState; passed: number; total: number } {
  const states = (checks ?? []).map(checkState)
  const passed = states.filter((s) => s === "pass").length
  const state = states.length === 0 ? "none" : states.includes("fail") ? "fail" : states.includes("pending") ? "pending" : "pass"
  return { state, passed, total: states.length }
}

export const checkName = (check: GhCheck) => (check.__typename === "CheckRun" ? check.name : check.context)
export const checkUrl = (check: GhCheck) => (check.__typename === "CheckRun" ? check.detailsUrl : check.targetUrl)
