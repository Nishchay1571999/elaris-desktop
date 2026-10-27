import { Globe, KeyRound, MoreHorizontal, SquareTerminal, Trash2, UserRound } from "lucide-react"
import { type FormEvent, useEffect, useState } from "react"

import type { McpServer } from "@/bindings/McpServer"
import {
  count,
  Details,
  Empty,
  FilterTabs,
  InstallButton,
  LoadingRows,
  Page,
  RowError,
  RowSummary,
  SearchField,
  Toolbar,
  Working,
} from "@/components/customizations/list-parts"
import { Button, IconButton } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ipc } from "@/lib/ipc"
import { MCP_CATALOG, type McpCatalogEntry } from "@/lib/mcp-catalog"
import { useMcp } from "@/stores/mcp"

type Filter = "all" | "installed" | "available"

/** A catalog server (installed or not), or one added outside Elaris. */
type Row = { id: string; entry?: McpCatalogEntry; server?: McpServer }

export function McpPage() {
  const servers = useMcp((s) => s.servers)
  const loadError = useMcp((s) => s.loadError)
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  // Servers installed or removed under the current filter stay put until it
  // changes, so a row doesn't vanish from under the button that was clicked.
  const [kept, setKept] = useState<Set<string>>(new Set())

  // Reload on every visit: `claude mcp add` and other tools edit the same file.
  useEffect(() => {
    void useMcp.getState().load()
  }, [])

  const changeFilter = (next: Filter) => {
    setFilter(next)
    setKept(new Set())
  }
  const keep = (id: string) => setKept((s) => new Set(s).add(id))

  const summary = servers
    ? `${count(servers.length, "server", "servers")} set up for every chat. They're saved in ~/.claude.json, so Claude Code uses them too.`
    : "Connect Model Context Protocol servers so the agent can use your services."

  if (!servers) {
    return (
      <Page title="MCP Servers" summary={summary}>
        {loadError ? (
          <Empty
            tone="error"
            title="Couldn't read ~/.claude.json"
            body={loadError}
            action={{ label: "Retry", run: () => void useMcp.getState().load() }}
          />
        ) : (
          <LoadingRows label="Loading MCP servers" />
        )}
      </Page>
    )
  }

  const byName = new Map(servers.map((s) => [s.name, s]))
  const rows: Row[] = [
    ...MCP_CATALOG.map((entry) => ({ id: entry.id, entry, server: byName.get(entry.id) })),
    ...servers.filter((s) => !MCP_CATALOG.some((e) => e.id === s.name)).map((server) => ({ id: server.name, server })),
  ]

  const installedCount = rows.filter((r) => r.server).length
  const q = query.trim().toLowerCase()
  const visible = rows
    .filter((row) => {
      const haystack = [row.id, row.entry?.name ?? "", row.entry?.description ?? "", row.server?.target ?? ""]
      if (q && !haystack.some((text) => text.toLowerCase().includes(q))) return false
      if (filter === "all" || kept.has(row.id)) return true
      return filter === "installed" ? !!row.server : !row.server
    })
    .sort((a, b) => (filter === "all" ? Number(!a.server) - Number(!b.server) : 0))

  return (
    <Page title="MCP Servers" summary={summary}>
      <Toolbar>
        <FilterTabs
          label="Show servers"
          value={filter}
          onChange={changeFilter}
          options={[
            { id: "all", label: "All", count: rows.length },
            { id: "installed", label: "Installed", count: installedCount },
            { id: "available", label: "Available", count: rows.length - installedCount },
          ]}
        />
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value)
            setKept(new Set())
          }}
          placeholder="Search servers"
        />
      </Toolbar>

      {visible.length > 0 ? (
        <ul className="mt-1 border-t border-border">
          {visible.map((row) => (
            <ServerRow
              key={row.id}
              row={row}
              open={expanded === row.id}
              onOpen={() => setExpanded(row.id)}
              onToggle={() => setExpanded((id) => (id === row.id ? null : row.id))}
              onChange={() => keep(row.id)}
            />
          ))}
        </ul>
      ) : query.trim() ? (
        <Empty
          title={`No servers match “${query.trim()}”`}
          body="Search looks at names, descriptions and the address or command each server runs."
          action={{ label: "Clear search", run: () => setQuery("") }}
        />
      ) : filter === "installed" ? (
        <Empty
          title="No MCP servers installed"
          body="A server gives the agent tools for one service, such as your issue tracker or a browser."
          action={{ label: "Browse available", run: () => changeFilter("available") }}
        />
      ) : (
        <Empty title="Every server in the catalog is installed" />
      )}
    </Page>
  )
}

function ServerRow({
  row,
  open,
  onOpen,
  onToggle,
  onChange,
}: {
  row: Row
  open: boolean
  onOpen: () => void
  onToggle: () => void
  onChange: () => void
}) {
  const { entry, server } = row
  const working = useMcp((s) => s.working[row.id])
  const failed = useMcp((s) => s.failed[row.id])
  const [asked, setAsked] = useState(false)
  const name = entry?.name ?? row.id
  const detailsId = `mcp-${row.id}-details`
  const needsKey = entry?.auth.kind === "key" && !server

  const install = () => {
    if (!entry) return
    if (needsKey) {
      setAsked(true)
      onOpen()
      return
    }
    onChange()
    void useMcp.getState().install(entry, {})
  }

  const confirmUninstall = async () => {
    if (await ipc.dialog.confirm(`The agent loses its ${name} tools in every chat.`, `Uninstall ${name}?`, "Uninstall")) {
      onChange()
      void useMcp.getState().remove(row.id)
    }
  }

  const target = server?.target ?? (entry ? targetOf(entry) : "")
  const local = server ? server.transport === "stdio" : entry?.config({}).type === "stdio"

  return (
    <li className="border-b border-border">
      <div className="group flex items-start gap-3 py-3.5">
        <RowSummary
          open={open}
          onToggle={onToggle}
          detailsId={detailsId}
          name={name}
          description={entry?.description ?? target}
          dimmed={working === "removing"}
          meta={
            <>
              <span className="flex items-center gap-1">
                {local ? (
                  <SquareTerminal className="size-3 text-subtle-foreground" />
                ) : (
                  <Globe className="size-3 text-subtle-foreground" />
                )}
                {local ? "Runs on this computer" : "Remote"}
              </span>
              {entry?.auth.kind === "oauth" && (
                <span className="flex items-center gap-1">
                  <UserRound className="size-3 text-subtle-foreground" />
                  {entry.auth.account} account
                </span>
              )}
              {entry?.auth.kind === "key" && (
                <span className="flex items-center gap-1">
                  <KeyRound className="size-3 text-subtle-foreground" />
                  API key
                </span>
              )}
              {!entry && <span>Added outside Elaris</span>}
            </>
          }
        />
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {working ? (
            <Working label={working === "installing" ? "Installing…" : "Removing…"} />
          ) : server ? (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More" ariaLabel={`More for ${name}`}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end" className="min-w-36">
                <MenuItem onSelect={() => void confirmUninstall()} className="text-destructive [&_svg]:text-destructive">
                  <Trash2 /> Uninstall
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : (
            <InstallButton label={`Install ${name}`} onClick={install} />
          )}
        </div>
      </div>

      {failed && <RowError message={`Couldn't ${server ? "uninstall" : "install"}: ${failed}`} />}
      {open && (
        <Details id={detailsId} rows={detailRows(row, target, local)}>
          {needsKey && entry?.auth.kind === "key" && (
            <KeyForm
              entry={entry}
              fields={entry.auth.fields}
              autoFocus={asked}
              busy={!!working}
              onInstall={onChange}
            />
          )}
        </Details>
      )}
    </li>
  )
}

/** Asks for the values a server needs before it is installed. */
function KeyForm({
  entry,
  fields,
  autoFocus,
  busy,
  onInstall,
}: {
  entry: McpCatalogEntry
  fields: Array<{ key: string; label: string; placeholder?: string; secret?: boolean }>
  autoFocus: boolean
  busy: boolean
  onInstall: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const complete = fields.every((f) => values[f.key]?.trim())

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!complete || busy) return
    onInstall()
    const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]))
    void useMcp.getState().install(entry, trimmed)
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      {fields.map((field, i) => (
        <label key={field.key} className="grid grid-cols-[7rem_1fr] items-center gap-x-4">
          <span className="text-muted-foreground">{field.label}</span>
          <input
            type={field.secret ? "password" : "text"}
            value={values[field.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            placeholder={field.placeholder}
            autoFocus={autoFocus && i === 0}
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-0 rounded-md border border-input bg-surface px-2 text-[13px] outline-none placeholder:text-subtle-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
      ))}
      <div className="grid grid-cols-[7rem_1fr] gap-x-4">
        <span />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={!complete || busy}
            className="bg-brand px-3 text-brand-foreground hover:bg-brand/90 hover:text-brand-foreground"
          >
            Install {entry.name}
          </Button>
          <span className="text-xs text-subtle-foreground">Saved in ~/.claude.json on this computer.</span>
        </div>
      </div>
    </form>
  )
}

function detailRows(row: Row, target: string, local: boolean): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [local ? "Command" : "Address", target],
    ["Tools named", `mcp__${row.id}__…`],
  ]
  const auth = row.entry?.auth
  if (auth?.kind === "oauth") {
    rows.push([
      "Sign-in",
      `Your ${auth.account} account. If its tools don't show up in a chat, sign in once by running /mcp in Claude Code.`,
    ])
  } else if (auth?.kind === "key") {
    rows.push(["Sign-in", row.server ? "API key saved in ~/.claude.json" : "Needs an API key, entered below"])
  } else if (auth?.kind === "none") {
    rows.push(["Sign-in", "None needed"])
  }
  return rows
}

/** The address or command a catalog entry will run, without its secrets. */
function targetOf(entry: McpCatalogEntry) {
  const config = entry.config({}) as { url?: string; command?: string; args?: string[] }
  return config.url ?? [config.command, ...(config.args ?? [])].join(" ")
}
