import { Command as Cmdk, defaultFilter } from "cmdk"
import { Check, Cpu, MessageSquare, Shield } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"

import type { PermissionPolicy } from "@/bindings/PermissionPolicy"
import { Kbd } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ProjectLogo } from "@/components/workspace/project-logo"
import { COMMANDS, type CommandGroup, effectiveBindings } from "@/lib/commands"
import { formatBinding } from "@/lib/keybindings"
import { MODELS, MODES, PERMISSIONS } from "@/lib/models"
import { baseName, relativeTime } from "@/lib/utils"
import { usePreferences } from "@/stores/preferences"
import { useSessions, useSettings } from "@/stores/sessions"
import { useCurrent, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

const GROUPS: CommandGroup[] = ["General", "Chat", "View", "Navigation"]

// Each item's value is what's searched, then an id after this mark to keep values unique.
const ID_MARK = "\u0001"
const itemValue = (searched: string, id: string) => `${searched}${ID_MARK}${id}`
const filter = (value: string, search: string, keywords?: string[]) =>
  defaultFilter(value.slice(0, value.indexOf(ID_MARK)), search, keywords)

/**
 * ⌘K: jump to a chat, folder or file, run any command, or change the open chat's
 * mode, model and permissions, all from the keyboard.
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent top className="overflow-hidden p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search chats, files and commands</DialogDescription>
        {/* Mounted only while open, so it starts fresh each time. */}
        {open && <PaletteBody close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({ close }: { close: () => void }) {
  const [query, setQuery] = useState("")
  const { sessionId } = useCurrent()
  const summaries = useSessions((s) => s.summaries)
  const updateSettings = useSessions((s) => s.updateSettings)
  const settings = useSettings(sessionId)
  const workspace = useWorkspace((s) => s.info)
  const recent = useWorkspace((s) => s.recent)
  const overrides = usePreferences((s) => s.keybindings)
  const bindings = useMemo(() => effectiveBindings(overrides), [overrides])

  const run = (action: () => void) => {
    close()
    // After the dialog lets go of focus, so whatever the action focuses keeps it.
    requestAnimationFrame(action)
  }

  const chats = summaries.filter((s) => s.workspace === (workspace?.root ?? null))
  const commands = COMMANDS.filter((c) => c.id !== "palette.open" && (!c.available || c.available()))

  return (
    <Cmdk label="Command palette" loop filter={filter} className="flex max-h-[min(70vh,32rem)] flex-col">
      <Cmdk.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Search chats and commands…"
        className="h-11 w-full shrink-0 border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-subtle-foreground"
      />
      <Cmdk.List className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle-foreground">
        <Cmdk.Empty className="px-3 py-8 text-center text-muted-foreground">Nothing matches “{query}”</Cmdk.Empty>

        {chats.length > 0 && (
          <Cmdk.Group heading="Chats">
            {chats.slice(0, query ? 50 : 6).map((chat) => (
              <Item
                key={chat.id}
                value={itemValue(chat.title, `chat:${chat.id}`)}
                icon={<MessageSquare />}
                hint={relativeTime(chat.updatedAt)}
                onSelect={() => run(() => useUi.getState().navigate({ sessionId: chat.id, view: { kind: "chat" } }))}
              >
                {chat.title || "Untitled chat"}
              </Item>
            ))}
          </Cmdk.Group>
        )}

        {GROUPS.map((group) => {
          const items = commands.filter((c) => c.group === group)
          if (items.length === 0) return null
          return (
            <Cmdk.Group key={group} heading={group}>
              {items.map((command) => (
                <Item
                  key={command.id}
                  value={itemValue(command.title, command.id)}
                  keywords={command.keywords}
                  icon={<command.icon />}
                  shortcut={formatBinding(bindings[command.id])}
                  onSelect={() => run(command.run)}
                >
                  {command.title}
                </Item>
              ))}
            </Cmdk.Group>
          )
        })}

        <Cmdk.Group heading={sessionId ? "This chat" : "New chat"}>
          {(Object.keys(MODES) as Array<keyof typeof MODES>).map((id) => {
            const Icon = MODES[id].icon
            return (
              <Item
                key={id}
                value={itemValue(`Mode ${MODES[id].label}`, `mode:${id}`)}
                icon={<Icon />}
                checked={settings.mode === id}
                hint={MODES[id].hint}
                onSelect={() => run(() => void updateSettings(sessionId, { mode: id }))}
              >
                Mode: {MODES[id].label}
              </Item>
            )
          })}
          {MODELS.map((model) => (
            <Item
              key={model.id}
              value={itemValue(`Model ${model.label}`, `model:${model.id}`)}
              icon={<Cpu />}
              checked={settings.model === model.id}
              hint={model.hint}
              onSelect={() => run(() => void updateSettings(sessionId, { model: model.id }))}
            >
              Model: {model.label}
            </Item>
          ))}
          {(Object.keys(PERMISSIONS) as PermissionPolicy[]).map((id) => (
            <Item
              key={id}
              value={itemValue(`Permissions ${PERMISSIONS[id].label}`, `permissions:${id}`)}
              icon={<Shield />}
              checked={settings.permissions === id}
              hint={PERMISSIONS[id].hint}
              onSelect={() => run(() => void updateSettings(sessionId, { permissions: id }))}
            >
              Permissions: {PERMISSIONS[id].label}
            </Item>
          ))}
        </Cmdk.Group>

        {recent.filter((path) => path !== workspace?.root).length > 0 && (
          <Cmdk.Group heading="Recent folders">
            {recent
              .filter((path) => path !== workspace?.root)
              .map((path) => (
                <Item
                  key={path}
                  value={itemValue(path, `folder:${path}`)}
                  icon={<ProjectLogo root={path} />}
                  hint={path}
                  onSelect={() => run(() => void useWorkspace.getState().open(path))}
                >
                  {baseName(path)}
                </Item>
              ))}
          </Cmdk.Group>
        )}
      </Cmdk.List>
      <footer className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-subtle-foreground">
        <span>
          <Kbd>↑↓</Kbd> to move
        </span>
        <span>
          <Kbd>↩</Kbd> to run
        </span>
        <span>
          <Kbd>Esc</Kbd> to close
        </span>
      </footer>
    </Cmdk>
  )
}

function Item({
  value,
  keywords,
  icon,
  hint,
  shortcut,
  checked,
  onSelect,
  children,
}: {
  value: string
  keywords?: string[]
  icon: ReactNode
  hint?: string
  shortcut?: string
  checked?: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <Cmdk.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 outline-none select-none data-[selected=true]:bg-accent [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {icon}
      <span className="min-w-0 shrink-0 truncate">{children}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{hint}</span>
      {checked && <Check className="text-brand!" />}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </Cmdk.Item>
  )
}
