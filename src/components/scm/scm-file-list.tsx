import {
  ChevronRight,
  Copy,
  EyeOff,
  FileDiff,
  FileText,
  FolderSearch,
  Minus,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react"
import { type KeyboardEvent, type MouseEvent, type ReactNode, useMemo, useState } from "react"

import type { DiffSide } from "@/bindings/DiffSide"
import type { ScmFile } from "@/bindings/ScmFile"
import type { ScmStatus } from "@/bindings/ScmStatus"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { IconButton } from "@/components/ui/button"
import { FileIcon } from "@/components/workspace/file-icon"
import { errorMessage, ipc } from "@/lib/ipc"
import {
  GROUP_ORDER,
  GROUP_TITLE,
  LETTER,
  type ScmGroupId,
  type TreeNode,
  buildTree,
  changeColor,
  flattenTree,
  sortFiles,
} from "@/lib/scm"
import { baseName, cn, parentDir } from "@/lib/utils"
import { useScm } from "@/stores/scm"
import { useCurrent, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

/** Which diff a row opens. Conflicts show against HEAD, markers and all. */
const SIDE: Record<ScmGroupId, DiffSide | undefined> = {
  conflicted: undefined,
  staged: "staged",
  unstaged: "unstaged",
  untracked: "untracked",
}

/** A row's identity across the panel: its group and path. */
const rowKey = (group: ScmGroupId, path: string) => `${group}:${path}`

/**
 * The changed files, grouped as VS Code groups them (Merge, Staged, Changes,
 * Untracked), as a flat list or a folder tree. Click opens the diff; ⌘-click
 * and ⇧-click select several for the context menu and hover actions.
 */
export function ScmFileList({ status }: { status: ScmStatus }) {
  const viewMode = useScm((s) => s.viewMode)
  const sortBy = useScm((s) => s.sortBy)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((id) => {
        const files = sortFiles(status[id], sortBy)
        const tree = viewMode === "tree" ? buildTree(files, id, sortBy) : null
        return { id, files, tree }
      }).filter((g) => g.files.length > 0),
    [status, viewMode, sortBy],
  )

  // Every file row on screen, in order, for ⇧-click ranges.
  const visibleRows = useMemo(
    () =>
      groups.flatMap((g) => {
        if (collapsed.has(g.id)) return []
        if (!g.tree) return g.files.map((f) => rowKey(g.id, f.path))
        return flattenTree(g.tree, collapsed)
          .filter((n) => n.kind === "file")
          .map((n) => rowKey(g.id, (n as Extract<TreeNode, { kind: "file" }>).file.path))
      }),
    [groups, collapsed],
  )

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  /** Files an action on `group`/`file` covers: the selection, if the row is in it. */
  const targets = (group: ScmGroupId, file: ScmFile): ScmFile[] => {
    const key = rowKey(group, file.path)
    if (!selected.has(key) || selected.size < 2) return [file]
    return status[group].filter((f) => selected.has(rowKey(group, f.path)))
  }

  const select = (event: MouseEvent, group: ScmGroupId, file: ScmFile) => {
    const key = rowKey(group, file.path)
    if (event.metaKey || event.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (!next.delete(key)) next.add(key)
        return next
      })
      setAnchor(key)
      return false
    }
    if (event.shiftKey && anchor) {
      const [a, b] = [visibleRows.indexOf(anchor), visibleRows.indexOf(key)].sort((x, y) => x - y)
      if (a >= 0) setSelected(new Set(visibleRows.slice(a, b + 1)))
      return false
    }
    setSelected(new Set([key]))
    setAnchor(key)
    return true
  }

  return (
    <div onKeyDown={moveFocus} className="pb-2 text-[13px]">
      {groups.map((group) => (
        <section key={group.id} aria-label={GROUP_TITLE[group.id]}>
          <GroupHeader
            group={group.id}
            files={group.files}
            open={!collapsed.has(group.id)}
            onToggle={() => toggle(group.id)}
          />
          {!collapsed.has(group.id) &&
            (group.tree ? (
              <Tree
                nodes={group.tree}
                depth={1}
                group={group.id}
                collapsed={collapsed}
                onToggle={toggle}
                selected={selected}
                onSelect={select}
                targets={targets}
              />
            ) : (
              group.files.map((file) => (
                <FileRow
                  key={file.path}
                  group={group.id}
                  file={file}
                  depth={1}
                  showDir
                  selected={selected.has(rowKey(group.id, file.path))}
                  onSelect={select}
                  targets={targets}
                />
              ))
            ))}
        </section>
      ))}
    </div>
  )
}

/** ↑/↓ move between rows, as in VS Code's lists. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-scm-row]")]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

function GroupHeader({
  group,
  files,
  open,
  onToggle,
}: {
  group: ScmGroupId
  files: ScmFile[]
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="group/row flex h-6 items-center pr-2 hover:bg-sidebar-accent">
      <button
        type="button"
        data-scm-row
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => e.key === "ArrowLeft" && open && onToggle()}
        className="flex h-full min-w-0 flex-1 items-center gap-1 pl-1.5 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase outline-none focus-visible:bg-sidebar-accent"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{GROUP_TITLE[group]}</span>
      </button>
      <FilesActions group={group} files={files} />
      <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">{files.length}</span>
    </div>
  )
}

/** Stage / unstage / discard for a group or folder, shown on hover. */
function FilesActions({ group, files }: { group: ScmGroupId; files: ScmFile[] }) {
  const { stage, unstage, discard } = useScm.getState()
  return (
    <span className="hidden items-center group-focus-within/row:flex group-hover/row:flex">
      {(group === "unstaged" || group === "untracked") && (
        <RowAction label={group === "untracked" ? "Delete all (move to Trash)" : "Discard all changes"} onClick={() => void discard(files)}>
          {group === "untracked" ? <Trash2 /> : <Undo2 />}
        </RowAction>
      )}
      {group === "staged" ? (
        <RowAction label="Unstage all" onClick={() => void unstage(files)}>
          <Minus />
        </RowAction>
      ) : (
        <RowAction label={group === "conflicted" ? "Mark all resolved (stage)" : "Stage all"} onClick={() => void stage(files)}>
          <Plus />
        </RowAction>
      )}
    </span>
  )
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="size-5 rounded [&_svg]:size-3.5"
    >
      {children}
    </IconButton>
  )
}

function Tree({
  nodes,
  depth,
  group,
  collapsed,
  onToggle,
  selected,
  onSelect,
  targets,
}: {
  nodes: TreeNode[]
  depth: number
  group: ScmGroupId
  collapsed: Set<string>
  onToggle: (id: string) => void
  selected: Set<string>
  onSelect: (event: MouseEvent, group: ScmGroupId, file: ScmFile) => boolean
  targets: (group: ScmGroupId, file: ScmFile) => ScmFile[]
}) {
  return nodes.map((node) =>
    node.kind === "file" ? (
      <FileRow
        key={node.id}
        group={group}
        file={node.file}
        depth={depth}
        selected={selected.has(rowKey(group, node.file.path))}
        onSelect={onSelect}
        targets={targets}
      />
    ) : (
      <div key={node.id}>
        <div className="group/row flex h-6 items-center pr-2 hover:bg-sidebar-accent">
          <button
            type="button"
            data-scm-row
            aria-expanded={!collapsed.has(node.id)}
            onClick={() => onToggle(node.id)}
            onKeyDown={(e) => {
              const open = !collapsed.has(node.id)
              if ((e.key === "ArrowLeft" && open) || (e.key === "ArrowRight" && !open)) onToggle(node.id)
            }}
            title={node.path}
            style={{ paddingLeft: depth * 12 + 4 }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:bg-sidebar-accent"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed.has(node.id) && "rotate-90")} />
            <FileIcon name={node.name} isDir open={!collapsed.has(node.id)} />
            <span className="truncate">{node.name}</span>
          </button>
          <FilesActions group={group} files={node.files} />
        </div>
        {!collapsed.has(node.id) && (
          <Tree
            nodes={node.children}
            depth={depth + 1}
            group={group}
            collapsed={collapsed}
            onToggle={onToggle}
            selected={selected}
            onSelect={onSelect}
            targets={targets}
          />
        )}
      </div>
    ),
  )
}

function FileRow({
  group,
  file,
  depth,
  showDir = false,
  selected,
  onSelect,
  targets,
}: {
  group: ScmGroupId
  file: ScmFile
  depth: number
  showDir?: boolean
  selected: boolean
  onSelect: (event: MouseEvent, group: ScmGroupId, file: ScmFile) => boolean
  targets: (group: ScmGroupId, file: ScmFile) => ScmFile[]
}) {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)
  const side = SIDE[group]
  const open = current.view.kind === "diff" && current.view.path === file.path && current.view.side === side
  const dir = showDir ? parentDir(file.path) : ""
  const openDiff = () => navigate({ view: side ? { kind: "diff", path: file.path, side } : { kind: "diff", path: file.path } })
  const { stage, unstage, discard } = useScm.getState()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/row flex h-6 items-center pr-2 hover:bg-sidebar-accent",
            selected && "bg-sidebar-accent",
            open && "bg-sidebar-selected",
          )}
        >
          <button
            type="button"
            data-scm-row
            onClick={(e) => onSelect(e, group, file) && openDiff()}
            onKeyDown={(e) => {
              if (e.key === " " && group !== "staged") {
                e.preventDefault()
                void stage(targets(group, file))
              }
            }}
            title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
            style={{ paddingLeft: depth * 12 + (showDir ? 8 : 22) }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:bg-sidebar-accent"
          >
            <FileIcon name={baseName(file.path)} isDir={false} />
            <span className={cn("shrink-0 truncate", file.kind === "deleted" && "line-through decoration-1")}>
              {baseName(file.path)}
            </span>
            {dir && <span className="min-w-0 truncate text-xs text-subtle-foreground">{dir}</span>}
            <span className="flex-1" />
          </button>
          <span className="hidden items-center group-focus-within/row:flex group-hover/row:flex">
            <RowAction label="Open file" onClick={() => void open_(file.path)}>
              <FileText />
            </RowAction>
            {(group === "unstaged" || group === "untracked") && (
              <RowAction label={group === "untracked" ? "Delete (move to Trash)" : "Discard changes"} onClick={() => void discard(targets(group, file))}>
                {group === "untracked" ? <Trash2 /> : <Undo2 />}
              </RowAction>
            )}
            {group === "staged" ? (
              <RowAction label="Unstage" onClick={() => void unstage(targets(group, file))}>
                <Minus />
              </RowAction>
            ) : (
              <RowAction label={group === "conflicted" ? "Mark resolved (stage)" : "Stage"} onClick={() => void stage(targets(group, file))}>
                <Plus />
              </RowAction>
            )}
          </span>
          <span
            aria-label={file.kind}
            className={cn("ml-1 w-3 shrink-0 text-center font-mono text-[11px] font-semibold", changeColor(file.kind))}
          >
            {LETTER[file.kind]}
          </span>
        </div>
      </ContextMenuTrigger>
      <FileMenu group={group} file={file} files={targets(group, file)} onOpenDiff={openDiff} />
    </ContextMenu>
  )
}

function FileMenu({
  group,
  file,
  files,
  onOpenDiff,
}: {
  group: ScmGroupId
  file: ScmFile
  files: ScmFile[]
  onOpenDiff: () => void
}) {
  const { stage, unstage, discard } = useScm.getState()
  const many = files.length > 1
  const suffix = many ? ` ${files.length} files` : ""
  return (
    <ContextMenuContent>
      {!many && (
        <>
          <ContextMenuItem onSelect={onOpenDiff}>
            <FileDiff /> Open Changes
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void open_(file.path)}>
            <FileText /> Open File
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {group === "staged" ? (
        <ContextMenuItem onSelect={() => void unstage(files)}>
          <Minus /> Unstage{suffix}
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => void stage(files)}>
          <Plus /> {group === "conflicted" ? "Mark Resolved" : "Stage"}
          {suffix}
        </ContextMenuItem>
      )}
      {(group === "unstaged" || group === "untracked") && (
        <ContextMenuItem onSelect={() => void discard(files)}>
          {group === "untracked" ? <Trash2 /> : <Undo2 />} {group === "untracked" ? "Delete" : "Discard Changes"}
          {suffix}
        </ContextMenuItem>
      )}
      {!many && (
        <>
          <ContextMenuSeparator />
          {group === "untracked" && (
            <ContextMenuItem onSelect={() => void ignore(file.path)}>
              <EyeOff /> Add to .gitignore
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void reveal(file.path)}>
            <FolderSearch /> Reveal in Finder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyPath(file.path, true)}>
            <Copy /> Copy Path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyPath(file.path, false)}>
            <Copy /> Copy Relative Path
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}

const report = (error: unknown) => useWorkspace.setState({ error: errorMessage(error) })

async function open_(path: string) {
  await ipc.workspace.openFile(path).catch(report)
}

async function reveal(path: string) {
  await ipc.workspace.reveal(path).catch(report)
}

async function ignore(path: string) {
  await useScm.getState().run("Updating .gitignore…", () => ipc.git.ignore(path))
}

async function copyPath(path: string, absolute: boolean) {
  const root = useWorkspace.getState().info?.root
  await navigator.clipboard.writeText(absolute && root ? `${root}/${path}` : path).catch(report)
}
