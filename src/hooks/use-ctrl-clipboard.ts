import { useEffect } from "react"

import { ipc } from "@/lib/ipc"
import { isInTerminal } from "@/lib/terminals"

const IS_MAC = navigator.platform.toLowerCase().startsWith("mac")
const ACTIONS = { KeyC: "copy", KeyX: "cut", KeyV: "paste" } as const

/**
 * Makes Ctrl+C / Ctrl+X / Ctrl+V do what ⌘ does on macOS, through the native
 * Edit actions, so pasting images works the same with either key. Not in a terminal,
 * where Ctrl+C interrupts.
 */
export function useCtrlClipboard() {
  useEffect(() => {
    if (!IS_MAC) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isInTerminal(e.target)) return
      const action = ACTIONS[e.code as keyof typeof ACTIONS]
      if (!action) return
      e.preventDefault()
      void ipc.editAction(action)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
