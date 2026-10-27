import type { ChangeKind } from "@/bindings/ChangeKind"
import { baseName, cn, parentDir } from "@/lib/utils"
import { useCurrent, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

const LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
}

export function changeColor(kind: ChangeKind): string {
  switch (kind) {
    case "added":
    case "untracked":
      return "text-git-added"
    case "deleted":
    case "conflicted":
      return "text-git-deleted"
    default:
      return "text-git-modified"
  }
}

export function ChangesList() {
  const { info, changes } = useWorkspace()
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)

  if (!info?.isGit) {
    return <p className="px-4 py-3 text-xs text-subtle-foreground">This folder isn't a git repository.</p>
  }
  if (changes.length === 0) {
    return <p className="px-4 py-3 text-xs text-subtle-foreground">No changes.</p>
  }

  return (
    <ul className="py-1 text-[13px]">
      {changes.map((change) => {
        const selected = current.view.kind === "diff" && current.view.path === change.path
        const dir = parentDir(change.path)
        return (
          <li key={change.path}>
            <button
              type="button"
              onClick={() => navigate({ view: { kind: "diff", path: change.path } })}
              title={change.path}
              className={cn(
                "flex h-6 w-full items-center gap-2 px-3 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                selected && "bg-sidebar-selected",
              )}
            >
              <span className={cn("truncate", change.kind === "deleted" && "line-through decoration-1")}>
                {baseName(change.path)}
              </span>
              {dir && <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{dir}</span>}
              {!dir && <span className="flex-1" />}
              <span
                aria-label={change.kind}
                className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", changeColor(change.kind))}
              >
                {LETTER[change.kind]}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
