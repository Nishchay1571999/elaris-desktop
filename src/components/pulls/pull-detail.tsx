import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react"
import { type ReactNode, useState } from "react"

import { SaveContextButton } from "@/components/chat/save-context-button"
import { ActivityBar } from "@/components/ui/activity-bar"
import { Button, IconButton } from "@/components/ui/button"
import { Menu, MenuCheckItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { checkName, checkState, checkUrl, type GhReviewThread, type MergeMethod, type PrDetail, type ReviewAction } from "@/lib/github"
import { useGh } from "@/hooks/use-gh"
import { invalidate } from "@/lib/gh-cache"
import { ipc } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { useContexts } from "@/stores/contexts"
import { useGitHub } from "@/stores/github"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { GhMarkdown } from "./gh-markdown"
import { Avatar, CheckIcon, ChecksBadge, DiffStat, Labels, ReviewBadge, since, StatePill } from "./pr-bits"
import { PullFiles } from "./pull-files"

type Tab = "conversation" | "files" | "checks" | "commits"

const PRIMARY = "h-7 gap-1.5 bg-brand px-2.5 text-brand-foreground hover:bg-brand/90 hover:text-brand-foreground"
const OUTLINE = "h-7 gap-1.5 border border-border-strong px-2.5 text-foreground"

/**
 * One pull request: what it says, what it changes, its checks, and what you can do with it.
 * `repo` (owner/name) is its repository; without it, the open folder's.
 */
export function PullDetail({ repo, number }: { repo?: string; number: number }) {
  const [actionError, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("conversation")
  const [busy, setBusy] = useState<string | null>(null)
  const branch = useWorkspace((s) => s.info?.branch)
  const folderRepo = useGitHub((s) => s.repo?.nameWithOwner)
  // Only a pull request on the open folder's repository can be checked out here.
  const local = !repo || repo.toLowerCase() === folderRepo?.toLowerCase()

  const target = repo ?? folderRepo ?? "folder"
  const { data: pr, error: loadError, revalidating, refresh } = useGh(`pr:${target}#${number}`, () => ipc.github.pr(repo, number))
  const error = actionError ?? (pr ? null : loadError)

  /** Runs a gh action, then reloads the pull request (and the branch, which some actions change). */
  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
      // What the action changed: this pull request, its diff, and every list it's in.
      invalidate(`pr:${target}#${number}`, `diff:${target}#${number}`, "search:")
      refresh()
      await Promise.all([useWorkspace.getState().refreshInfo(), useGitHub.getState().refreshBranchPr()])
      return true
    } catch (e) {
      setError(useGitHub.getState().handleError(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  if (!pr) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 pt-6">
          <BackLink kind="pulls" />
          {error ? (
            <p className="selectable mt-6 text-[13px] text-destructive">{error}</p>
          ) : (
            <p className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading #{number}…
            </p>
          )}
        </div>
      </div>
    )
  }

  const open = pr.state === "OPEN"
  const checkedOut = local && branch === pr.headRefName

  return (
    <div className="relative h-full overflow-y-auto">
      <ActivityBar active={revalidating} className="sticky top-0 z-20" />
      <div className="mx-auto max-w-4xl px-6 pt-6 pb-16">
        <BackLink kind="pulls" />

        <header className="mt-4">
          {repo && <RepoLink repo={repo} />}
          <h1 className="selectable text-xl font-semibold tracking-tight">
            {pr.title} <span className="font-normal text-subtle-foreground">#{pr.number}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
            <StatePill state={pr.state} isDraft={pr.isDraft} />
            <span className="flex items-center gap-1.5">
              <Avatar login={pr.author.login} size={18} />
              <span className="text-foreground">{pr.author.login}</span>
              {pr.state === "MERGED" ? "merged" : "wants to merge"} {pr.commits.length} commit{pr.commits.length === 1 ? "" : "s"} into
              <Branch name={pr.baseRefName} /> from <Branch name={pr.headRefName} />
            </span>
            <Labels labels={pr.labels} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {open && !pr.isDraft && <MergeButton pr={pr} repo={repo} busy={busy} act={act} />}
            {open && pr.isDraft && (
              <Button className={PRIMARY} disabled={!!busy} onClick={() => void act("ready", () => ipc.github.setState(repo, pr.number, "ready"))}>
                {busy === "ready" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Ready for review
              </Button>
            )}
            {local && (
              <Button
                className={OUTLINE}
                disabled={!!busy || checkedOut || pr.state === "MERGED"}
                title={checkedOut ? "This branch is checked out" : `Check out ${pr.headRefName} in this folder`}
                onClick={() => void act("checkout", () => ipc.github.checkout(pr.number))}
              >
                {busy === "checkout" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                {checkedOut ? "Checked out" : "Check out"}
              </Button>
            )}
            <Button className={OUTLINE} onClick={() => void ipc.openUrl(pr.url)}>
              <ExternalLink className="size-3.5" /> GitHub
            </Button>
            <div className="flex-1" />
            <ChecksBadge checks={pr.statusCheckRollup} />
            <ReviewBadge decision={pr.reviewDecision} />
            <SaveItem kind="pr" repo={repo} number={pr.number} />
            <IconButton label="Refresh" onClick={refresh}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            <MoreMenu pr={pr} repo={repo} busy={busy} act={act} />
          </div>
          {pr.mergeable === "CONFLICTING" && open && (
            <p className="mt-3 rounded-lg border border-git-deleted/40 bg-git-deleted/10 px-3 py-2 text-xs text-git-deleted">
              This branch has conflicts with {pr.baseRefName}. {local ? "Check it out, merge" : "Merge"} {pr.baseRefName} in and push before merging.
            </p>
          )}
          {error && <p className="selectable mt-3 text-[13px] text-destructive">{error}</p>}
        </header>

        <nav role="tablist" aria-label="Pull request" className="mt-6 flex items-center gap-0.5 border-b border-border">
          <TabButton id="conversation" tab={tab} setTab={setTab}>
            Conversation{" "}
            <Count
              n={pr.comments.length + pr.reviews.filter((r) => r.body || r.state !== "COMMENTED").length + (pr.reviewThreads?.length ?? 0)}
            />
          </TabButton>
          <TabButton id="files" tab={tab} setTab={setTab}>
            Files <Count n={pr.changedFiles} />
            <DiffStat additions={pr.additions} deletions={pr.deletions} />
          </TabButton>
          <TabButton id="checks" tab={tab} setTab={setTab}>
            Checks <Count n={pr.statusCheckRollup.length} />
          </TabButton>
          <TabButton id="commits" tab={tab} setTab={setTab}>
            Commits <Count n={pr.commits.length} />
          </TabButton>
        </nav>

        <div className="pt-5">
          {tab === "conversation" && <Conversation pr={pr} repo={repo} busy={busy} act={act} />}
          {tab === "files" && <PullFiles repo={repo} target={target} number={pr.number} updatedAt={pr.updatedAt} />}
          {tab === "checks" && <Checks pr={pr} />}
          {tab === "commits" && <Commits pr={pr} />}
        </div>
      </div>
    </div>
  )
}

export type Act = (label: string, action: () => Promise<unknown>) => Promise<boolean>

/**
 * Saves the pull request or issue as it is now, discussion and attachments included, and
 * copies its id. Typing `%` in any chat lists saved ones to hand the agent as context.
 */
export function SaveItem({ kind, repo, number }: { kind: "pr" | "issue"; repo: string | undefined; number: number }) {
  return (
    <SaveContextButton
      sigil="%"
      noun={kind === "pr" ? "pull request" : "issue"}
      save={() => useContexts.getState().saveItem(kind, repo, number)}
      exportMarkdown={(id) => ipc.items.export(id)}
    />
  )
}

/** Back to the list this pull request or issue was opened from, filters as they were. */
export function BackLink({ kind }: { kind: "pulls" | "issues" }) {
  const navigate = useUi((s) => s.navigate)
  return (
    <button
      type="button"
      onClick={() => navigate({ view: { kind } })}
      className="flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeft className="size-3.5" /> {kind === "pulls" ? "Pull requests" : "Issues"}
    </button>
  )
}

/** The repository over a pull request's or issue's title, linking to it on GitHub. */
export function RepoLink({ repo }: { repo: string }) {
  return (
    <button
      type="button"
      onClick={() => void ipc.openUrl(`https://github.com/${repo}`)}
      className="mb-1 block text-[13px] text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:underline"
    >
      {repo}
    </button>
  )
}

function Branch({ name }: { name: string }) {
  return <code className="rounded bg-brand-soft px-1.5 py-px font-mono text-[11.5px] text-brand">{name}</code>
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{n}</span>
}

function TabButton({ id, tab, setTab, children }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        "-mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        tab === id && "border-brand text-foreground",
      )}
    >
      {children}
    </button>
  )
}

const METHODS: Record<MergeMethod, { label: string; hint: string }> = {
  squash: { label: "Squash and merge", hint: "One commit on the base branch" },
  merge: { label: "Create a merge commit", hint: "Keep every commit, plus a merge commit" },
  rebase: { label: "Rebase and merge", hint: "Replay the commits onto the base branch" },
}

function MergeButton({ pr, repo, busy, act }: { pr: PrDetail; repo?: string; busy: string | null; act: Act }) {
  const [method, setMethod] = useState<MergeMethod>("squash")
  const [deleteBranch, setDeleteBranch] = useState(true)

  const merge = async () => {
    const ok = await ipc.dialog.confirm(
      `${METHODS[method].label} #${pr.number} into ${pr.baseRefName}?${deleteBranch ? ` ${pr.headRefName} will be deleted.` : ""}`,
      "Merge pull request",
      "Merge",
    )
    if (ok) await act("merge", () => ipc.github.merge(repo, pr.number, method, deleteBranch))
  }

  return (
    <div className="flex items-center">
      <Button className={cn(PRIMARY, "rounded-r-none")} disabled={!!busy || pr.mergeable === "CONFLICTING"} onClick={() => void merge()}>
        {busy === "merge" ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
        {METHODS[method].label}
      </Button>
      <Menu>
        <MenuTrigger asChild disabled={!!busy}>
          <Button aria-label="Merge options" className={cn(PRIMARY, "rounded-l-none border-l border-brand-foreground/20 px-1.5")}>
            <ChevronDown className="size-3.5" />
          </Button>
        </MenuTrigger>
        <MenuContent className="w-64">
          <MenuLabel>Merge method</MenuLabel>
          {(Object.keys(METHODS) as MergeMethod[]).map((id) => (
            <MenuCheckItem key={id} checked={method === id} onSelect={() => setMethod(id)}>
              <span className="flex-1">
                <span className="block">{METHODS[id].label}</span>
                <span className="block text-[11px] text-subtle-foreground">{METHODS[id].hint}</span>
              </span>
            </MenuCheckItem>
          ))}
          <MenuSeparator />
          <MenuCheckItem checked={deleteBranch} onSelect={(e) => (e.preventDefault(), setDeleteBranch((d) => !d))}>
            Delete {pr.headRefName} after merging
          </MenuCheckItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

function MoreMenu({ pr, repo, busy, act }: { pr: PrDetail; repo?: string; busy: string | null; act: Act }) {
  const open = pr.state === "OPEN"
  return (
    <Menu>
      <MenuTrigger asChild disabled={!!busy}>
        <IconButton label="More actions">
          <MoreHorizontal className="size-4" />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end">
        {open && !pr.isDraft && (
          <MenuItem onSelect={() => void act("draft", () => ipc.github.setState(repo, pr.number, "draft"))}>Convert to draft</MenuItem>
        )}
        {open && pr.isDraft && (
          <MenuItem onSelect={() => void act("ready", () => ipc.github.setState(repo, pr.number, "ready"))}>Mark ready for review</MenuItem>
        )}
        {open && (
          <MenuItem
            className="text-destructive"
            onSelect={async () => {
              if (await ipc.dialog.confirm(`Close #${pr.number} without merging?`, "Close pull request", "Close"))
                void act("close", () => ipc.github.setState(repo, pr.number, "close"))
            }}
          >
            Close pull request
          </MenuItem>
        )}
        {pr.state === "CLOSED" && (
          <MenuItem onSelect={() => void act("reopen", () => ipc.github.setState(repo, pr.number, "reopen"))}>Reopen</MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={() => void navigator.clipboard.writeText(pr.url)}>
          <Copy /> Copy link
        </MenuItem>
        <MenuItem onSelect={() => void navigator.clipboard.writeText(pr.headRefName)}>
          <Copy /> Copy branch name
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/* -------------------------------------------------------------------------- */
/* Conversation                                                               */
/* -------------------------------------------------------------------------- */

type Entry =
  | { kind: "comment"; id: string; login: string; body: string; at: string }
  | { kind: "review"; id: string; login: string; body: string; at: string; state: PrDetail["reviews"][number]["state"] }
  | { kind: "thread"; id: string; login: string; at: string; thread: GhReviewThread }

const REVIEW_LABEL: Record<string, [string, string]> = {
  APPROVED: ["approved these changes", "text-git-added"],
  CHANGES_REQUESTED: ["requested changes", "text-git-deleted"],
  COMMENTED: ["reviewed", "text-muted-foreground"],
  DISMISSED: ["had a review dismissed", "text-subtle-foreground"],
  PENDING: ["started a review", "text-subtle-foreground"],
}

function Conversation({ pr, repo, busy, act }: { pr: PrDetail; repo?: string; busy: string | null; act: Act }) {
  const me = useGitHub((s) => s.status?.user?.login)
  const entries: Entry[] = [
    ...pr.comments.map((c) => ({ kind: "comment" as const, id: c.id, login: c.author.login, body: c.body, at: c.createdAt })),
    ...pr.reviews
      // A plain "reviewed" with no text is only the wrapper of line comments, shown as threads below.
      .filter((r) => r.body || r.state !== "COMMENTED")
      .map((r) => ({ kind: "review" as const, id: r.id, login: r.author.login, body: r.body, at: r.submittedAt, state: r.state })),
    ...(pr.reviewThreads ?? [])
      .filter((t) => t.comments.nodes.length > 0)
      .map((t) => {
        const first = t.comments.nodes[0]
        return { kind: "thread" as const, id: t.id, login: first.author?.login ?? "ghost", at: first.createdAt, thread: t }
      }),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  return (
    <div className="flex flex-col gap-4">
      <Bubble login={pr.author.login} at={pr.createdAt} action="opened this">
        {pr.body.trim() ? <GhMarkdown text={pr.body} /> : <p className="text-[13px] text-subtle-foreground italic">No description.</p>}
      </Bubble>

      {entries.map((entry) =>
        entry.kind === "comment" ? (
          <Bubble key={entry.id} login={entry.login} at={entry.at} action="commented">
            <GhMarkdown text={entry.body} />
          </Bubble>
        ) : entry.kind === "thread" ? (
          <ThreadEntry key={entry.id} thread={entry.thread} />
        ) : (
          <Bubble
            key={entry.id}
            login={entry.login}
            at={entry.at}
            action={REVIEW_LABEL[entry.state]?.[0] ?? "reviewed"}
            tone={REVIEW_LABEL[entry.state]?.[1]}
          >
            {entry.body && <GhMarkdown text={entry.body} />}
          </Bubble>
        ),
      )}

      {pr.state !== "MERGED" && (
        <ReplyBox
          canReview={me !== pr.author.login}
          busy={busy}
          onSubmit={(action, body) =>
            act(action, () =>
              action === "comment-only" ? ipc.github.comment(repo, pr.number, body) : ipc.github.review(repo, pr.number, action, body),
            )
          }
        />
      )}
    </div>
  )
}

/** How many lines of code above a line comment to show with it. */
const HUNK_LINES = 6

/** A line comment and its replies, under the lines of the diff it's on. */
function ThreadEntry({ thread }: { thread: GhReviewThread }) {
  const [first, ...replies] = thread.comments.nodes
  // An outdated thread has no line in the current diff, only the one it was left on.
  const line = thread.line ?? thread.originalLine
  const start = thread.startLine ?? thread.originalStartLine
  const where = `${thread.path}${line ? `:${start && start !== line ? `${start}-` : ""}${line}` : ""}`
  const hunk = first.diffHunk
    .split("\n")
    .filter((l) => !l.startsWith("@@"))
    .slice(-HUNK_LINES)
  const flags = [thread.isResolved && "resolved", thread.isOutdated && "outdated"].filter(Boolean).join(", ")

  return (
    <Bubble login={first.author?.login ?? "ghost"} at={first.createdAt} action="commented on a line">
      <div className="-mx-4 -mt-3 mb-3 border-b border-border">
        <button
          type="button"
          onClick={() => void ipc.openUrl(first.url)}
          className="flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          <span className="min-w-0 flex-1 truncate">{where}</span>
          {flags && <span className="font-sans text-[11px] text-subtle-foreground">{flags}</span>}
          <ExternalLink className="size-3 shrink-0" />
        </button>
        {hunk.length > 0 && (
          <pre className="overflow-x-auto bg-surface-sunken py-1 font-mono text-[11.5px] leading-5">
            {hunk.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "px-4",
                  l.startsWith("+") && "bg-git-added/10 text-git-added",
                  l.startsWith("-") && "bg-git-deleted/10 text-git-deleted",
                )}
              >
                {l || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
      <GhMarkdown text={first.body} />
      {replies.map((c) => (
        <div key={c.id} className="-mx-4 mt-3 border-t border-border px-4 pt-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar login={c.author?.login ?? "ghost"} size={16} />
            <span className="font-medium text-foreground">{c.author?.login ?? "ghost"}</span>
            <span title={new Date(c.createdAt).toLocaleString()}>· {since(c.createdAt)}</span>
          </p>
          <GhMarkdown text={c.body} />
        </div>
      ))}
    </Bubble>
  )
}

export function Bubble({
  login,
  at,
  action,
  tone,
  children,
}: {
  login: string
  at: string
  action: string
  tone?: string
  children?: ReactNode
}) {
  const hasBody = Boolean(children)
  return (
    <article className="flex gap-3">
      <Avatar login={login} size={28} className="mt-0.5" />
      <div className={cn("min-w-0 flex-1", hasBody && "overflow-hidden rounded-xl border border-border")}>
        <header className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", hasBody ? "border-b border-border bg-surface-sunken px-3 py-2" : "py-1.5")}>
          <span className="font-medium text-foreground">{login}</span>
          <span className={tone}>{action}</span>
          <span title={new Date(at).toLocaleString()}>· {since(at)}</span>
        </header>
        {hasBody && <div className="selectable px-4 py-3">{children}</div>}
      </div>
    </article>
  )
}

/**
 * Comment, or review: approve or request changes (not on your own pull request, which
 * GitHub doesn't allow, nor on an issue).
 */
export function ReplyBox({
  canReview,
  busy,
  onSubmit,
}: {
  canReview: boolean
  busy: string | null
  onSubmit: (action: ReviewAction | "comment-only", body: string) => Promise<boolean>
}) {
  const [body, setBody] = useState("")
  const submit = async (action: ReviewAction | "comment-only") => {
    if (await onSubmit(action, body)) setBody("")
  }
  const empty = body.trim() === ""

  return (
    <div className="ml-10 overflow-hidden rounded-xl border border-input bg-surface-elevated focus-within:border-brand/60">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) {
            e.preventDefault()
            void submit("comment-only")
          }
        }}
        rows={3}
        placeholder="Leave a comment (Markdown)…"
        aria-label="Comment"
        className="block w-full resize-y bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-subtle-foreground"
      />
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="flex-1 text-[11px] text-subtle-foreground">⌘↩ to comment</span>
        {canReview && (
          <>
            <Button
              className={OUTLINE}
              disabled={!!busy || empty}
              title={empty ? "Say what needs to change" : undefined}
              onClick={() => void submit("request-changes")}
            >
              {busy === "request-changes" && <LoaderCircle className="size-3.5 animate-spin" />}
              Request changes
            </Button>
            <Button className={OUTLINE} disabled={!!busy} onClick={() => void submit("approve")}>
              {busy === "approve" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5 text-git-added" />}
              Approve
            </Button>
          </>
        )}
        <Button className={PRIMARY} disabled={!!busy || empty} onClick={() => void submit("comment-only")}>
          {busy === "comment-only" && <LoaderCircle className="size-3.5 animate-spin" />}
          Comment
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Checks and commits                                                         */
/* -------------------------------------------------------------------------- */

function Checks({ pr }: { pr: PrDetail }) {
  if (pr.statusCheckRollup.length === 0) return <p className="text-[13px] text-muted-foreground">No checks ran on this pull request.</p>
  const order = { fail: 0, pending: 1, pass: 2 }
  const checks = [...pr.statusCheckRollup].sort((a, b) => order[checkState(a)] - order[checkState(b)])
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {checks.map((check, i) => {
        const state = checkState(check)
        const workflow = check.__typename === "CheckRun" ? check.workflowName : undefined
        const took =
          check.__typename === "CheckRun" && check.completedAt && check.startedAt
            ? Math.max(0, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000))
            : null
        return (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
            <CheckIcon state={state} />
            <span className="min-w-0 flex-1 truncate">
              {workflow && <span className="text-muted-foreground">{workflow} / </span>}
              {checkName(check)}
            </span>
            {took !== null && <span className="text-xs text-subtle-foreground tabular-nums">{took < 60 ? `${took}s` : `${Math.round(took / 60)}m`}</span>}
            {checkUrl(check) && (
              <button
                type="button"
                onClick={() => void ipc.openUrl(checkUrl(check))}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Details <ExternalLink className="size-3" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Commits({ pr }: { pr: PrDetail }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {pr.commits.map((commit) => (
        <li key={commit.oid} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
          <GitCommitHorizontal className="size-4 shrink-0 text-subtle-foreground" />
          <span className="min-w-0 flex-1 truncate">{commit.messageHeadline}</span>
          {commit.authors[0] && <Avatar login={commit.authors[0].login || commit.authors[0].name || "?"} size={16} />}
          <span className="text-xs text-subtle-foreground">{since(commit.authoredDate)}</span>
          <code className="font-mono text-[11px] text-muted-foreground">{commit.oid.slice(0, 7)}</code>
        </li>
      ))}
    </ul>
  )
}
