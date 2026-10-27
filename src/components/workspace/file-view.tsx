import { useEffect, useState } from "react"

import type { FilePreview } from "@/bindings/FilePreview"
import { useHighlighted } from "@/hooks/use-highlighted"
import { errorMessage, ipc } from "@/lib/ipc"
import { useWorkspace } from "@/stores/workspace"

import { CodeText, LanguageServer } from "./code"
import { PaneHeader } from "./pane-header"

export function FileView({ path }: { path: string }) {
  const [file, setFile] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Re-read whenever the workspace reports changes, so the agent's edits show up.
  const changes = useWorkspace((s) => s.changes)

  useEffect(() => {
    let cancelled = false
    ipc.workspace
      .readFile(path)
      .then((f) => !cancelled && (setFile(f), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [path, changes])

  // A truncated preview isn't the file the server would see.
  const { lines, status } = useHighlighted(path, file?.text ?? null, { lsp: !file?.truncated })

  return (
    <div className="flex h-full flex-col">
      <PaneHeader path={path} actions={<LanguageServer path={path} status={status} />}>
        {file && <span className="text-xs text-subtle-foreground">{formatSize(file.size)}</span>}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="p-4 text-sm text-destructive">{error}</p>}
        {file && file.text === null && (
          <p className="p-4 text-sm text-muted-foreground">Binary file, not shown.</p>
        )}
        {file?.text != null && (
          <pre className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-12 shrink-0 pr-4 text-right text-subtle-foreground select-none">{i + 1}</span>
                <span className="pr-4">
                  <CodeText line={line} />
                </span>
              </div>
            ))}
            {file.truncated && <p className="px-4 pt-2 text-subtle-foreground">… truncated (file is too large to show in full)</p>}
          </pre>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
