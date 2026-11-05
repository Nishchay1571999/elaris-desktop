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
