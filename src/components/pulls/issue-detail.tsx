import { CircleCheck, CircleSlash, Copy, ExternalLink, LoaderCircle, MoreHorizontal, RefreshCw, RotateCcw } from "lucide-react"
import { useState } from "react"

import { ActivityBar } from "@/components/ui/activity-bar"
import { Button, IconButton } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { useGh } from "@/hooks/use-gh"
import { invalidate } from "@/lib/gh-cache"
import { ipc } from "@/lib/ipc"
import { useGitHub } from "@/stores/github"

import { GhMarkdown } from "./gh-markdown"
import { Avatar, IssueStatePill, Labels } from "./pr-bits"
import { BackLink, Bubble, RepoLink, ReplyBox, SaveItem } from "./pull-detail"

const OUTLINE = "h-7 gap-1.5 border border-border-strong px-2.5 text-foreground"

/** One issue on `repo` (owner/name): what it says, who's on it, and replying, closing or reopening it. */
export function IssueDetail({ repo, number }: { repo: string; number: number }) {
  const [actionError, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const key = `issue:${repo}#${number}`
  const { data: issue, error: loadError, revalidating, refresh } = useGh(key, () => ipc.github.issue(repo, number))
  const error = actionError ?? (issue ? null : loadError)

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await action()
      invalidate(key, "search:")
      refresh()
      return true
    } catch (e) {
      setError(useGitHub.getState().handleError(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  if (!issue) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 pt-6">
          <BackLink kind="issues" />
          {error ? (
            <p className="selectable mt-6 text-[13px] text-destructive">{error}</p>
          ) : (
            <p className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading {repo}#{number}…
            </p>
          )}
        </div>
      </div>
    )
  }

  const open = issue.state === "OPEN"

  return (
    <div className="h-full overflow-y-auto">
      <ActivityBar active={revalidating} className="sticky top-0 z-20" />
      <div className="mx-auto max-w-4xl px-6 pt-6 pb-16">
        <BackLink kind="issues" />

        <header className="mt-4">
          <RepoLink repo={repo} />
          <h1 className="selectable text-xl font-semibold tracking-tight">
            {issue.title} <span className="font-normal text-subtle-foreground">#{issue.number}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
            <IssueStatePill state={issue.state} reason={issue.stateReason} />
            <span className="flex items-center gap-1.5">
              <Avatar login={issue.author.login} size={18} />
              <span className="text-foreground">{issue.author.login}</span>
              opened this · {issue.comments.length} comment{issue.comments.length === 1 ? "" : "s"}
            </span>
            <Labels labels={issue.labels} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {open ? (
              <Button className={OUTLINE} disabled={!!busy} onClick={() => void act("close", () => ipc.github.issueSetState(repo, number, "close"))}>
                {busy === "close" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CircleCheck className="size-3.5 text-[oklch(0.62_0.17_300)]" />}
                Close as done
              </Button>
            ) : (
              <Button className={OUTLINE} disabled={!!busy} onClick={() => void act("reopen", () => ipc.github.issueSetState(repo, number, "reopen"))}>
                {busy === "reopen" ? <LoaderCircle className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                Reopen
              </Button>
            )}
            <Button className={OUTLINE} onClick={() => void ipc.openUrl(issue.url)}>
              <ExternalLink className="size-3.5" /> GitHub
            </Button>
            <div className="flex-1" />
            {issue.assignees.length > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Assigned to
                {issue.assignees.map((a) => (
                  <Avatar key={a.login} login={a.login} size={18} />
                ))}
              </span>
            )}
            <SaveItem kind="issue" repo={repo} number={number} />
            <IconButton label="Refresh" onClick={refresh}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            <Menu>
              <MenuTrigger asChild disabled={!!busy}>
                <IconButton label="More actions">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {open && (
                  <MenuItem onSelect={() => void act("close", () => ipc.github.issueSetState(repo, number, "close-not-planned"))}>
                    <CircleSlash /> Close as not planned
                  </MenuItem>
                )}
                {open && <MenuSeparator />}
                <MenuItem onSelect={() => void navigator.clipboard.writeText(issue.url)}>
                  <Copy /> Copy link
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
          {error && <p className="selectable mt-3 text-[13px] text-destructive">{error}</p>}
        </header>

        <div className="mt-6 flex flex-col gap-4 border-t border-border pt-5">
          <Bubble login={issue.author.login} at={issue.createdAt} action="opened this">
            {issue.body.trim() ? <GhMarkdown text={issue.body} /> : <p className="text-[13px] text-subtle-foreground italic">No description.</p>}
          </Bubble>
          {issue.comments.map((comment) => (
            <Bubble key={comment.id} login={comment.author.login} at={comment.createdAt} action="commented">
              <GhMarkdown text={comment.body} />
            </Bubble>
          ))}
          <ReplyBox canReview={false} busy={busy} onSubmit={(action, body) => act(action, () => ipc.github.issueComment(repo, number, body))} />
        </div>
      </div>
    </div>
  )
}
