import { useEffect } from "react"

import { isInTerminal } from "@/lib/terminals"
import { isMac } from "@/lib/utils"
import { useSessions } from "@/stores/sessions"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

/**
 * App-wide shortcuts: ⌘N new chat, ⌘O open folder, ⌘B / ⌘⌥B toggle panels, ⌘[ / ⌘] history,
 * ⌘T / Ctrl+T a terminal tab in the open chat. Inside a terminal only ⌘ (and ⌘/Ctrl+T) are
 * the app's; other Ctrl keys go to the shell.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return
      if (isInTerminal(e.target) && e.code !== "KeyT" && !(isMac && e.metaKey)) return
      const ui = useUi.getState()
      // `code` so ⌥ doesn't change the letter on macOS.
      switch (e.code) {
        case "KeyT": {
          const { sessionId, view } = ui.history[ui.index]
          // Only where the tab bar shows: a chat with messages, not the new-chat screen.
          const session = sessionId ? useSessions.getState().sessions[sessionId] : undefined
          if (view.kind !== "chat" || !session?.messages.length) return
          void ui.openTerminal(session.id)
          break
        }
        case "KeyN":
          ui.newChat()
          break
        case "KeyO":
          void useWorkspace.getState().pickAndOpen()
          break
        case "KeyB":
          if (e.altKey) ui.setRightOpen(!ui.rightOpen)
          else ui.setLeftOpen(!ui.leftOpen)
          break
        case "BracketLeft":
          ui.back()
          break
        case "BracketRight":
          ui.forward()
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
