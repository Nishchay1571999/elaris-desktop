import { useEffect, useMemo, useState } from "react"

import type { SemanticTokens } from "@/bindings/SemanticTokens"
import type { ServerStatus } from "@/bindings/ServerStatus"
import { ipc } from "@/lib/ipc"
import { highlightLines, languageOf, type Line, withSemanticTokens } from "@/lib/syntax"
import { useCodeIntel } from "@/stores/code"

/** While a server indexes, ask again this often, this many times. */
const BUSY_RETRY_MS = 2000
const BUSY_RETRIES = 30

/**
 * `text` (the contents of `path`) as coloured lines: highlight.js right away,
 * then the language server's semantic tokens once it answers. `lsp: false`
 * skips the server, e.g. while the agent is still writing the file.
 */
export function useHighlighted(
  path: string,
  text: string | null,
  { lsp = true }: { lsp?: boolean } = {},
): { lines: Line[]; status: ServerStatus | null } {
  const base = useMemo(() => (text == null ? [] : highlightLines(text, languageOf(path))), [path, text])
  const [result, setResult] = useState<{ text: string; tokens: SemanticTokens | null; status: ServerStatus } | null>(
    null,
  )
  const epoch = useCodeIntel((s) => s.epoch)

  useEffect(() => {
    if (!lsp || text == null) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (attempt: number) => {
      ipc.code
        .highlights(path, text)
        .then(({ tokens, status }) => {
          if (cancelled) return
          // Keep the last colours while a busy server answers with nothing new.
          setResult((prev) => ({ text, status, tokens: tokens ?? (prev?.text === text ? prev.tokens : null) }))
          if (status.busy && attempt < BUSY_RETRIES) timer = setTimeout(() => ask(attempt + 1), BUSY_RETRY_MS)
        })
        .catch(() => !cancelled && setResult(null))
    }
    ask(0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [path, text, lsp, epoch])

  // Tokens for older text would land on the wrong characters.
  const tokens = result?.text === text ? result.tokens : null
  const lines = useMemo(() => (tokens ? withSemanticTokens(base, tokens) : base), [base, tokens])
  return { lines, status: lsp ? (result?.status ?? null) : null }
}
