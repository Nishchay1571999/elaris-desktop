import { Switch } from "radix-ui"
import { Bot, Lightbulb, MoreHorizontal, Server, Trash2, Webhook } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useState } from "react"

import {
  count,
  Details,
  Empty,
  FilterTabs,
  InstallButton,
  Page,
  RowSummary,
  SearchField,
  Toolbar,
} from "@/components/customizations/list-parts"
import { IconButton } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ipc } from "@/lib/ipc"
import { PART_KINDS, PLUGIN_CATALOG, type Plugin, type PluginPartKind } from "@/lib/plugin-catalog"
import { usePlugins } from "@/stores/plugins"

type Filter = "all" | "installed" | "available"

/** Same icons as the sidebar's Customizations, so a plugin's parts read as the things they add. */
const PART_ICONS: Record<PluginPartKind, LucideIcon> = {
  skills: Lightbulb,
  agents: Bot,
  mcp: Server,
  hooks: Webhook,
}

function matches(plugin: Plugin, query: string) {
  if (!query) return true
  const haystack = [plugin.name, plugin.description, ...Object.values(plugin.parts).flat()]
  return haystack.some((text) => text.toLowerCase().includes(query))
}

export function PluginsPage() {
  const installed = usePlugins((s) => s.installed)
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  // Plugins installed or removed under the current filter stay put until it
  // changes, so a row doesn't vanish from under the button that was clicked.
  const [kept, setKept] = useState<Set<string>>(new Set())

  const changeFilter = (next: Filter) => {
    setFilter(next)
    setKept(new Set())
  }
  const keep = (id: string) => setKept((s) => new Set(s).add(id))

  const installedCount = PLUGIN_CATALOG.filter((p) => installed[p.id]).length
  const counts: Record<Filter, number> = {
    all: PLUGIN_CATALOG.length,
    installed: installedCount,
    available: PLUGIN_CATALOG.length - installedCount,
  }

  const q = query.trim().toLowerCase()
  const visible = PLUGIN_CATALOG.filter((p) => {
    if (!matches(p, q)) return false
    if (filter === "all" || kept.has(p.id)) return true
    return filter === "installed" ? !!installed[p.id] : !installed[p.id]
  }).sort((a, b) => (filter === "all" ? Number(!installed[a.id]) - Number(!installed[b.id]) : 0))

  return (
    <Page title="Plugins" summary={<ActiveSummary installed={installed} />}>
      <Toolbar>
        <FilterTabs
          label="Show plugins"
          value={filter}
          onChange={changeFilter}
          options={[
            { id: "all", label: "All", count: counts.all },
            { id: "installed", label: "Installed", count: counts.installed },
            { id: "available", label: "Available", count: counts.available },
          ]}
        />
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value)
            setKept(new Set())
          }}
          placeholder="Search plugins"
        />
      </Toolbar>

      {visible.length > 0 ? (
        <ul className="mt-1 border-t border-border">
          {visible.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              open={expanded === plugin.id}
              onToggle={() => setExpanded((id) => (id === plugin.id ? null : plugin.id))}
              onChange={() => keep(plugin.id)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          filter={filter}
          query={query.trim()}
          onClear={() => setQuery("")}
          onBrowse={() => changeFilter("available")}
        />
      )}
    </Page>
  )
}

/** What the switched-on plugins add up to, e.g. "2 plugins on, adding 5 skills, 1 agent and 2 hooks." */
function ActiveSummary({ installed }: { installed: Record<string, { enabled: boolean }> }) {
  const on = PLUGIN_CATALOG.filter((p) => installed[p.id]?.enabled)
  if (on.length === 0) return <>Bundles of skills, agents, MCP servers and hooks, added in one step.</>

  return (
    <>
      {count(on.length, "plugin", "plugins")} on, adding {partsSentence(on)}.
    </>
  )
}

function PluginRow({
  plugin,
  open,
  onToggle,
  onChange,
}: {
  plugin: Plugin
  open: boolean
  onToggle: () => void
  onChange: () => void
}) {
  const state = usePlugins((s) => s.installed[plugin.id])
  const { install, uninstall, setEnabled } = usePlugins.getState()
  const off = state && !state.enabled
  const detailsId = `plugin-${plugin.id}-details`

  const confirmUninstall = async () => {
    if (await ipc.dialog.confirm(`Its ${partsSentence([plugin])} will be removed.`, `Uninstall ${plugin.name}?`, "Uninstall")) {
      uninstall(plugin.id)
      onChange()
    }
  }

  return (
    <li className="border-b border-border">
      <div className="group flex items-start gap-3 py-3.5">
        <RowSummary
          open={open}
          onToggle={onToggle}
          detailsId={detailsId}
          name={plugin.name}
          badge={off && <span className="text-xs text-subtle-foreground">Off</span>}
          description={plugin.description}
          meta={<PartsLine plugin={plugin} />}
          dimmed={off}
        />

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {state ? (
            <>
              <Switch.Root
                checked={state.enabled}
                onCheckedChange={(checked) => setEnabled(plugin.id, checked)}
                aria-label={`${plugin.name} ${state.enabled ? "on" : "off"}`}
                className="relative mr-1 h-4 w-7 shrink-0 rounded-full bg-border-strong transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:bg-brand"
              >
                <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-foreground transition-transform duration-150 data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-brand-foreground" />
              </Switch.Root>
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label="More" ariaLabel={`More for ${plugin.name}`}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end" className="min-w-36">
                  <MenuItem
                    onSelect={() => void confirmUninstall()}
                    className="text-destructive [&_svg]:text-destructive"
                  >
                    <Trash2 /> Uninstall
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          ) : (
            <InstallButton
              label={`Install ${plugin.name}`}
              onClick={() => {
                install(plugin.id)
                onChange()
              }}
            />
          )}
        </div>
      </div>

      {open && <PluginDetails id={detailsId} plugin={plugin} />}
    </li>
  )
}

/** "3 skills · 1 agent · 1 MCP server", each with its Customizations icon. */
function PartsLine({ plugin }: { plugin: Plugin }) {
  return (
    <>
      {PART_KINDS.map(({ kind, one, many }) => {
        const n = plugin.parts[kind]?.length ?? 0
        if (n === 0) return null
        const Icon = PART_ICONS[kind]
        return (
          <span key={kind} className="flex items-center gap-1">
            <Icon className="size-3 text-subtle-foreground" />
            <span className="tabular-nums">{count(n, one, many)}</span>
          </span>
        )
      })}
    </>
  )
}

function PluginDetails({ id, plugin }: { id: string; plugin: Plugin }) {
  const parts = PART_KINDS.flatMap(({ kind, many }): Array<[string, string]> => {
    const names = plugin.parts[kind]
    return names?.length ? [[many[0].toUpperCase() + many.slice(1), names.join(", ")]] : []
  })
  return <Details id={id} rows={[...parts, ["Version", plugin.version]]} />
}

/** "5 skills, 1 agent and 2 hooks" across `plugins`. */
function partsSentence(plugins: Plugin[]) {
  const parts = PART_KINDS.map(({ kind, one, many }) => {
    const n = plugins.reduce((sum, p) => sum + (p.parts[kind]?.length ?? 0), 0)
    return n > 0 ? count(n, one, many) : null
  }).filter((s): s is string => s !== null)
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]
}

function EmptyState({
  filter,
  query,
  onClear,
  onBrowse,
}: {
  filter: Filter
  query: string
  onClear: () => void
  onBrowse: () => void
}) {
  let title: string
  let body: string
  let action: { label: string; run: () => void } | null = null

  if (query) {
    title = `No plugins match “${query}”`
    body = "Search looks at names, descriptions and the skills, agents and servers inside each plugin."
    action = { label: "Clear search", run: onClear }
  } else if (filter === "installed") {
    title = "No plugins installed"
    body = "A plugin adds its skills, agents, MCP servers and hooks in one step, and removes them the same way."
    action = { label: "Browse available", run: onBrowse }
  } else {
    title = "Everything in the catalog is installed"
    body = "New plugins will show up here as they are published."
  }

  return <Empty title={title} body={body} action={action} />
}
