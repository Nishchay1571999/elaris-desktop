/** Styling for one line of a unified diff, shared by the Changes pane and tool calls. */
export function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "text-subtle-foreground"
  if (line.startsWith("@@")) return "text-brand bg-brand-soft"
  if (line.startsWith("+")) return "bg-diff-add text-foreground"
  if (line.startsWith("-")) return "bg-diff-del text-foreground"
  return "text-muted-foreground"
}

/**
 * A line diff of `before` → `after`, as unified-diff lines without headers:
 * " kept", "-removed", "+added". Edits are small, so a plain LCS table is fine.
 */
export function diffLines(before: string, after: string): string[] {
  const a = before ? before.split("\n") : []
  const b = after ? after.split("\n") : []

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  // lcs[i][j]: length of the longest common subsequence of midA[i..] and midB[j..].
  const lcs = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0))
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const middle: string[] = []
  let i = 0
  let j = 0
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      middle.push(` ${midA[i++]}`)
      j++
    } else if (j < midB.length && (i === midA.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      middle.push(`+${midB[j++]}`)
    } else {
      middle.push(`-${midA[i++]}`)
    }
  }

  return [...a.slice(0, start).map((l) => ` ${l}`), ...middle, ...a.slice(endA).map((l) => ` ${l}`)]
}
