import { BookmarkPlus, Check, ChevronDown, LoaderCircle } from "lucide-react"
import { useState } from "react"

import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Tooltip } from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { tokenLabel } from "@/stores/contexts"
import { useSessions } from "@/stores/sessions"

const BUTTON =
  "flex h-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 disabled:hover:bg-transparent"

/**
 * Saves something for other chats to be handed (a chat as `#ctx-…`, a pull request or
 * issue as `%pr-…`) and copies its id; the menu copies it as Markdown instead.
 */
export function SaveContextButton({
  sigil,
  noun,
  disabled = false,
  disabledLabel,
  save,
  exportMarkdown,
  className,
}: {
  sigil: "#" | "%"
  /** "chat", "pull request"… */
  noun: string
  disabled?: boolean
  /** The tooltip while disabled. */
  disabledLabel?: string
  /** Saves it; `null` if that failed and said so already. */
  save: () => Promise<{ id: string; tokens: number } | null>
  exportMarkdown: (id: string) => Promise<string>
  className?: string
}) {
  const [saved, setSaved] = useState<{ id: string; tokens: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const off = busy || disabled

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      useSessions.setState({ error: "Couldn't copy to the clipboard" })
      return false
    }
  }

  const run = async (then: (id: string) => Promise<string>) => {
    setBusy(true)
    try {
      const result = await save()
      if (!result) return
      if (!(await copy(await then(result.id)))) return
      setSaved({ id: result.id, tokens: result.tokens })
      setTimeout(() => setSaved(null), 4000)
    } catch (error) {
      useSessions.setState({ error: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const label = saved
    ? `Saved as ${sigil}${saved.id} (${tokenLabel(saved.tokens)}), copied. Type ${sigil} in any chat to attach it.`
    : busy
      ? `Saving the ${noun}…`
      : disabled && disabledLabel
        ? disabledLabel
        : `Save ${noun} as context and copy its ${sigil}id`

  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      <Tooltip label={label}>
        <button
          type="button"
          disabled={off}
          onClick={() => void run(async (id) => `${sigil}${id}`)}
          aria-label={`Save ${noun} as context and copy its id`}
          className={cn(BUTTON, "gap-1 px-1.5", saved && "text-brand hover:text-brand")}
        >
          {saved ? (
            <Check className="size-3.5" />
          ) : busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <BookmarkPlus className="size-3.5" />
          )}
          {saved && (
            <span className="font-mono text-[11.5px]">
              {sigil}
              {saved.id}
            </span>
          )}
        </button>
      </Tooltip>
      <Menu>
        <MenuTrigger asChild disabled={off}>
          <button type="button" aria-label="More ways to save" className={cn(BUTTON, "w-4")}>
            <ChevronDown className="size-3" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => void run(async (id) => `${sigil}${id}`)}>Save and copy {sigil}id</MenuItem>
          <MenuItem onSelect={() => void run(exportMarkdown)}>Save and copy as Markdown</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
