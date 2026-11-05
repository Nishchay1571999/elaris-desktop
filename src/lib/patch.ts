/** One file of a unified diff, as `gh pr diff` prints it. */
export interface PatchFile {
  path: string
  /** The path before a rename, if it was renamed. */
  from: string | null
  status: "added" | "deleted" | "renamed" | "modified" | "binary"
  additions: number
  deletions: number
  /** The hunks, from the first `@@` on; empty for binary files. */
  lines: string[]
}

const unquote = (p: string) => p.replace(/^"(.*)"$/, "$1")

/** Splits a unified diff into its files. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let inHunks = false

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = { path: unquote(match?.[2] ?? line.slice(11)), from: null, status: "modified", additions: 0, deletions: 0, lines: [] }
      files.push(file)
      inHunks = false
      continue
    }
    if (!file) continue
    if (!inHunks) {
      if (line.startsWith("new file mode")) file.status = "added"
      else if (line.startsWith("deleted file mode")) file.status = "deleted"
      else if (line.startsWith("rename from ")) {
        file.status = "renamed"
        file.from = unquote(line.slice(12))
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10))
      else if (line.startsWith("Binary files ")) file.status = "binary"
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = unquote(line.slice(4).replace(/^b\//, ""))
      else if (line.startsWith("@@")) inHunks = true
      if (!inHunks) continue
    }
    file.lines.push(line)
    if (line.startsWith("+")) file.additions++
    else if (line.startsWith("-")) file.deletions++
  }
  // The diff ends with a newline, leaving an empty last line.
  for (const f of files) while (f.lines.at(-1) === "") f.lines.pop()
  return files
}

/** A one-file diff split for hunk staging: the file header, then each hunk from its `@@` line. */
export interface SplitDiff {
  header: string[]
  hunks: string[][]
}

export function splitHunks(diff: string): SplitDiff {
  const lines = diff.split("\n")
  // The diff ends with a newline, leaving an empty last line.
  while (lines.at(-1) === "") lines.pop()
  const header: string[] = []
  const hunks: string[][] = []
  for (const line of lines) {
    if (line.startsWith("@@")) hunks.push([line])
    else if (hunks.length) hunks[hunks.length - 1].push(line)
    else header.push(line)
  }
  return { header, hunks }
}

/** A patch of just one hunk, for `git apply --recount`. */
export function hunkPatch({ header }: SplitDiff, hunk: string[]): string {
  return `${[...header, ...hunk].join("\n")}\n`
}
