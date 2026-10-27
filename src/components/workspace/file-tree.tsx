import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"

import type { ChangeKind } from "@/bindings/ChangeKind"
import type { FileEntry } from "@/bindings/FileEntry"
import { cn } from "@/lib/utils"
import { useCurrent, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { FileIcon } from "./file-icon"
import { changeColor } from "./changes-list"

export function FileTree() {
  const { info, children, expanded, toggleDir, changes } = useWorkspace()
  const byPath = useMemo(() => new Map(changes.map((c) => [c.path, c.kind])), [changes])
  // Every folder that contains a change, so collapsed folders can show a dot.
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>()
    for (const { path } of changes) {
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i))
    }
    return dirs
  }, [changes])
  const [rootOpen, setRootOpen] = useState(true)

  if (!info) return null

  return (
    <div role="tree" aria-label="Files" className="py-1 text-[13px]">
      <button
        type="button"
        onClick={() => setRootOpen(!rootOpen)}
        aria-expanded={rootOpen}
        className="flex h-6 w-full items-center gap-1 px-2 text-left font-medium hover:bg-sidebar-accent"
      >
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", rootOpen && "rotate-90")} />
        {info.name}
      </button>
      {rootOpen && children[""] && (
        <Level entries={children[""]} depth={1} children_={children} expanded={expanded} byPath={byPath} changedDirs={changedDirs} toggle={toggleDir} />
      )}
    </div>
  )
}

interface LevelProps {
  entries: FileEntry[]
  depth: number
  children_: Record<string, FileEntry[]>
  expanded: Record<string, true>
  byPath: Map<string, ChangeKind>
  changedDirs: Set<string>
  toggle: (path: string) => Promise<void>
}

function Level({ entries, depth, children_, expanded, byPath, changedDirs, toggle }: LevelProps) {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)

  return (
    <ul role="group">
      {entries.map((entry) => {
        const open = Boolean(expanded[entry.path])
        const kind = byPath.get(entry.path)
        const selected = current.view.kind === "file" && current.view.path === entry.path
        const dirChanged = entry.isDir && !open && changedDirs.has(entry.path)

        return (
          <li key={entry.path} role="treeitem" aria-expanded={entry.isDir ? open : undefined}>
            <button
              type="button"
              onClick={() =>
                entry.isDir ? void toggle(entry.path) : navigate({ view: { kind: "file", path: entry.path } })
              }
              style={{ paddingLeft: 8 + depth * 12 }}
              className={cn(
                "flex h-6 w-full items-center gap-1.5 pr-2 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                selected && "bg-sidebar-selected",
              )}
            >
              {entry.isDir ? (
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <FileIcon name={entry.name} isDir={entry.isDir} open={open} />
              <span className={cn("truncate", kind ? changeColor(kind) : "text-sidebar-foreground/90")}>{entry.name}</span>
              {dirChanged && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-git-modified" />}
            </button>
            {entry.isDir && open && children_[entry.path] && (
              <Level
                entries={children_[entry.path]}
                depth={depth + 1}
                children_={children_}
                expanded={expanded}
                byPath={byPath}
                changedDirs={changedDirs}
                toggle={toggle}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
