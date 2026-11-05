/** Pure helpers for the Source Control panel: badges, sorting, and the tree view. */
import type { ChangeKind } from "@/bindings/ChangeKind"
import type { ChangedFile } from "@/bindings/ChangedFile"
import type { ScmFile } from "@/bindings/ScmFile"
import type { ScmStatus } from "@/bindings/ScmStatus"

/** The letter VS Code shows beside a changed file. */
export const LETTER: Record<ChangeKind, string> = {
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

/** The panel's groups, in the order they're shown. */
export type ScmGroupId = "conflicted" | "staged" | "unstaged" | "untracked"

export const GROUP_TITLE: Record<ScmGroupId, string> = {
  conflicted: "Merge Changes",
  staged: "Staged Changes",
  unstaged: "Changes",
  untracked: "Untracked Changes",
}

export const GROUP_ORDER: ScmGroupId[] = ["conflicted", "staged", "unstaged", "untracked"]

/** Every changed file in the panel. */
export function changeCount(status: ScmStatus | null): number {
  if (!status) return 0
  return status.conflicted.length + status.staged.length + status.unstaged.length + status.untracked.length
}

/** One entry per file, the most telling kind winning; matches the Rust `flatten`. */
export function flatten(status: ScmStatus): ChangedFile[] {
  const rank: Record<ChangeKind, number> = { conflicted: 0, renamed: 1, deleted: 2, added: 3, untracked: 4, modified: 5 }
  const byPath = new Map<string, ChangedFile>()
  for (const file of [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked]) {
    const seen = byPath.get(file.path)
    if (!seen || rank[file.kind] < rank[seen.kind]) byPath.set(file.path, { path: file.path, kind: file.kind })
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Paths to hand git for a file: a rename needs both ends to unstage cleanly. */
export function gitPaths(files: ScmFile[]): string[] {
  return [...new Set(files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])))]
}

export type SortBy = "path" | "name" | "status"

const KIND_ORDER: Record<ChangeKind, number> = { conflicted: 0, added: 1, untracked: 2, modified: 3, renamed: 4, deleted: 5 }

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export function sortFiles(files: ScmFile[], by: SortBy): ScmFile[] {
  const byPath = (a: ScmFile, b: ScmFile) => a.path.localeCompare(b.path)
  const compare: Record<SortBy, (a: ScmFile, b: ScmFile) => number> = {
    path: byPath,
    name: (a, b) => nameOf(a.path).localeCompare(nameOf(b.path)) || byPath(a, b),
    status: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byPath(a, b),
  }
  return [...files].sort(compare[by])
}

export interface TreeFolder {
  kind: "folder"
  /** Unique within the panel: group and path. */
  id: string
  /** Shown name; compacted chains read `src/lib`. */
  name: string
  /** Workspace-relative path of the folder. */
  path: string
  children: TreeNode[]
  /** Every file under it, for folder-wide actions. */
  files: ScmFile[]
}

export interface TreeFile {
  kind: "file"
  id: string
  name: string
  file: ScmFile
}

export type TreeNode = TreeFolder | TreeFile

/**
 * Files as folders, VS Code-style: folders first, then files, each by name,
 * and a folder whose only child is a folder shown as one row (`src/lib`).
 */
export function buildTree(files: ScmFile[], idPrefix: string, sortBy: SortBy = "name"): TreeNode[] {
  const root: TreeFolder = { kind: "folder", id: idPrefix, name: "", path: "", children: [], files: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let folder = root
    folder.files.push(file)
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/")
      let next = folder.children.find((c): c is TreeFolder => c.kind === "folder" && c.path === path)
      if (!next) {
        next = { kind: "folder", id: `${idPrefix}:${path}/`, name: parts[i], path, children: [], files: [] }
        folder.children.push(next)
      }
      next.files.push(file)
      folder = next
    }
    folder.children.push({ kind: "file", id: `${idPrefix}:${file.path}`, name: parts.at(-1)!, file })
  }
  return arrange(root.children, sortBy)
}

function arrange(nodes: TreeNode[], sortBy: SortBy): TreeNode[] {
  const folders = nodes
    .filter((n): n is TreeFolder => n.kind === "folder")
    .map((folder) => {
      let node = folder
      // Fold single-folder chains into one row.
      while (node.children.length === 1 && node.children[0].kind === "folder") {
        const only: TreeFolder = node.children[0]
        node = { ...only, name: `${node.name}/${only.name}` }
      }
      return { ...node, children: arrange(node.children, sortBy) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = nodes.filter((n): n is TreeFile => n.kind === "file")
  const sorted = sortFiles(
    files.map((f) => f.file),
    sortBy === "path" ? "name" : sortBy,
  )
  return [...folders, ...sorted.map((file) => files.find((f) => f.file === file)!)]
}

/** The ids of every row a tree shows when all folders are open, in order. */
export function flattenTree(nodes: TreeNode[], collapsed: Set<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node)
      if (node.kind === "folder" && !collapsed.has(node.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** `Co-authored-by:` trailers appended to a message, skipping ones already there. */
export function addCoAuthors(message: string, people: string[]): string {
  const trailers = people.map((p) => `Co-authored-by: ${p}`).filter((t) => !message.includes(t))
  if (trailers.length === 0) return message
  const body = message.trimEnd()
  const separator = /\n(Co-authored-by|Signed-off-by): .+$/.test(body) ? "\n" : "\n\n"
  return `${body}${separator}${trailers.join("\n")}`
}
