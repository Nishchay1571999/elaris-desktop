import { useEffect } from "react"

import { COMMANDS, effectiveBindings } from "@/lib/commands"
import { matches } from "@/lib/keybindings"
import { isInTerminal } from "@/lib/terminals"
import { isMac } from "@/lib/utils"
import { usePreferences } from "@/stores/preferences"

/** Where Ctrl keys mean something to the user (emacs keys on macOS, shells), so only ⌘ is the app's. */
function ownsCtrl(target: EventTarget | null): boolean {
  if (isInTerminal(target)) return true
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))
}

/**
 * App-wide shortcuts, from the command list (lib/commands.ts) with the user's changes
 * from Settings → Keyboard. Inside a terminal only ⌘ (and the new-terminal key) are the
 * app's; other Ctrl keys go to the shell.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A shortcut field in Settings is recording this key.
      if (e.defaultPrevented) return
      const bindings = effectiveBindings(usePreferences.getState().keybindings)
      const strict = ownsCtrl(e.target)
      const inTerminal = isInTerminal(e.target)
      for (const command of COMMANDS) {
        const binding = bindings[command.id]
        if (!binding || !matches(e, binding, strict)) continue
        // Off macOS, Ctrl is both the app's modifier and the shell's: only a new terminal is taken.
        if (inTerminal && !isMac && command.id !== "terminal.new") return
        if (command.available && !command.available()) return
        e.preventDefault()
        command.run()
        return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
