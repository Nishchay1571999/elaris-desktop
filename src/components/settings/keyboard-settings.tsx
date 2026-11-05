import { RotateCcw } from "lucide-react"
import { useMemo, useState } from "react"

import { Button, IconButton } from "@/components/ui/button"
import { COMMANDS, type CommandGroup, effectiveBindings } from "@/lib/commands"
import { formatBinding, fromEvent } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/stores/preferences"

import { SectionHeader } from "./settings-page"

const GROUPS: CommandGroup[] = ["General", "Chat", "View", "Git", "Navigation"]

/** Every command with its shortcut; click one to record a new key. */
export function KeyboardSettings() {
  const overrides = usePreferences((s) => s.keybindings)
  const setKeybinding = usePreferences((s) => s.setKeybinding)
  const resetKeybindings = usePreferences((s) => s.resetKeybindings)
  const bindings = useMemo(() => effectiveBindings(overrides), [overrides])
  const [recording, setRecording] = useState<string | null>(null)

  // Which commands share each shortcut, to flag clashes.
  const users = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [id, binding] of Object.entries(bindings)) {
      if (binding) map.set(binding, [...(map.get(binding) ?? []), id])
    }
    return map
  }, [bindings])

  return (
    <>
      <SectionHeader title="Keyboard" summary="Shortcuts for the commands in the palette (⌘K). Click a shortcut to change it.">
        <Button
          disabled={Object.keys(overrides).length === 0}
          onClick={resetKeybindings}
          className="border border-border-strong text-foreground"
        >
          <RotateCcw className="size-3.5" /> Reset all
        </Button>
      </SectionHeader>

      {GROUPS.map((group) => (
        <section key={group} className="mb-6">
          <h3 className="mb-2 text-[13px] font-semibold">{group}</h3>
          <div className="divide-y divide-border rounded-xl border border-border bg-surface-elevated/40">
            {COMMANDS.filter((c) => c.group === group).map((command) => {
              const binding = bindings[command.id]
              const clash = binding ? (users.get(binding) ?? []).filter((id) => id !== command.id) : []
              const changed = command.id in overrides
              return (
                <div key={command.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
                  <command.icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{command.title}</div>
                    {clash.length > 0 && (
                      <div className="mt-0.5 text-xs text-git-modified">
                        Also {COMMANDS.find((c) => c.id === clash[0])?.title}; the one listed first wins
                      </div>
                    )}
                  </div>
                  {changed && (
                    <IconButton label="Back to default" onClick={() => setKeybinding(command.id, undefined)}>
                      <RotateCcw className="size-3.5" />
                    </IconButton>
                  )}
                  <Recorder
                    binding={binding}
                    recording={recording === command.id}
                    onStart={() => setRecording(command.id)}
                    onStop={() => setRecording(null)}
                    onRecord={(next) => {
                      // Recording the default again drops the override.
                      setKeybinding(command.id, next === (command.binding ?? null) ? undefined : next)
                      setRecording(null)
                    }}
                  />
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}

/** Shows a shortcut; while recording, the next key press becomes it. Esc cancels, ⌫ clears. */
function Recorder({
  binding,
  recording,
  onStart,
  onStop,
  onRecord,
}: {
  binding: string | null
  recording: boolean
  onStart: () => void
  onStop: () => void
  onRecord: (binding: string | null) => void
}) {
  return (
    <button
      type="button"
      aria-label={recording ? "Press the new shortcut" : `Change shortcut, now ${formatBinding(binding) || "none"}`}
      onClick={recording ? onStop : onStart}
      onBlur={onStop}
      onKeyDown={(e) => {
        if (!recording) return
        // Keeps the app's own shortcuts from firing while one is being set.
        e.preventDefault()
        e.stopPropagation()
        if (e.key === "Escape") return onStop()
        if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey) return onRecord(null)
        const next = fromEvent(e.nativeEvent)
        if (next) onRecord(next)
      }}
      className={cn(
        "flex h-7 min-w-24 shrink-0 items-center justify-center rounded-md border border-input bg-surface-sunken px-2 font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        recording && "border-brand text-brand",
      )}
    >
      {recording ? "Press keys…" : formatBinding(binding) || <span className="text-subtle-foreground">None</span>}
    </button>
  )
}
