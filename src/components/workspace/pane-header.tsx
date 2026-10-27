import { X } from "lucide-react"
import type { ReactNode } from "react"

import { IconButton } from "@/components/ui/button"
import { useUi } from "@/stores/ui"

/** Header for file and diff views, with a close button back to the chat. `actions` sit by the close button. */
export function PaneHeader({ path, children, actions }: { path: string; children?: ReactNode; actions?: ReactNode }) {
  const navigate = useUi((s) => s.navigate)
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
      <span className="selectable min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>
      {children}
      <div className="flex-1" />
      {actions}
      <IconButton label="Close" onClick={() => navigate({ view: { kind: "chat" } })}>
        <X className="size-4" />
      </IconButton>
    </div>
  )
}
