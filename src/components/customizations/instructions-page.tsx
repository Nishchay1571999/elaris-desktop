import { MoreHorizontal, Trash2 } from "lucide-react"
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react"

import type { InstructionFile } from "@/bindings/InstructionFile"
import type { InstructionScope } from "@/bindings/InstructionScope"
import {
  count,
  Empty,
  LoadingRows,
  Page,
  RowError,
  RowSummary,
  Working,
} from "@/components/customizations/list-parts"
import { Button, IconButton } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ipc } from "@/lib/ipc"
import { cn, isMac, relativeTime } from "@/lib/utils"
import { useInstructions } from "@/stores/instructions"
import { useWorkspace } from "@/stores/workspace"

/** Brand strength for each file read, in order; the strip and the rows share it. */
const SHADES = [1, 0.62, 0.4, 0.26, 0.16]

const USER_SUFFIX = "/.claude/CLAUDE.md"

const COPY: Record<InstructionScope, { description: string; placeholder: string }> = {
  user: {
    description: "How you like to work, in every folder: answer style, tools you prefer, things never to do.",
    placeholder: "- Keep answers short; skip the recap at the end.\n- Use pnpm, never npm.\n- Ask before adding a dependency.",
  },
  parent: {
    description: "From a folder that contains this one, so it applies here too.",
    placeholder: "",
  },
  project: {
    description: "Commit it, and everyone who works on this repo gets the same guidance in Elaris and Claude Code.",
    placeholder:
      "# This project\n\n- Run the tests with `pnpm test` before saying a change works.\n- Components live in src/components, one per file.\n- Never edit the generated files in src/bindings.",
  },
  local: {
    description: "Notes for you alone in this folder. Keep CLAUDE.local.md out of git.",
    placeholder: "- My dev server runs on port 3001.\n- Sample data is in ~/fixtures/shop.",
  },
}

/** Roughly what a file costs in context: about four characters a token for English and code. */
const tokensOf = (text: string) => Math.ceil(text.length / 4)
const linesOf = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0)
const number = new Intl.NumberFormat("en")

export function InstructionsPage() {
  const files = useInstructions((s) => s.files)
  const loadError = useInstructions((s) => s.loadError)
  const workspace = useWorkspace((s) => s.info)
  const [open, setOpen] = useState<string | null>(null)

  // Reload on every visit and when the folder changes: Claude Code and editors write these too.
  useEffect(() => {
    void useInstructions.getState().load()
  }, [workspace?.root])

  if (!files) {
    return (
      <Page title="Instructions" summary="Guidance the agent reads at the start of every chat.">
        {loadError ? (
          <Empty
            tone="error"
            title="Couldn't read your instructions"
            body={loadError}
            action={{ label: "Retry", run: () => void useInstructions.getState().load() }}
          />
        ) : (
          <LoadingRows rows={3} label="Loading instructions" />
        )}
      </Page>
    )
  }

  const user = files.find((f) => f.scope === "user")
  const home = user?.path.endsWith(USER_SUFFIX) ? user.path.slice(0, -USER_SUFFIX.length) : null
  const read = files.filter((f) => f.exists && f.content.trim())
  const shade = (file: InstructionFile) => {
    const i = read.indexOf(file)
    return i === -1 ? null : SHADES[Math.min(i, SHADES.length - 1)]
  }
  const total = read.reduce((sum, f) => sum + tokensOf(f.content), 0)
  const where = workspace ? ` in ${workspace.name}` : ""

  const toggle = (path: string) => setOpen((current) => (current === path ? null : path))
  const groups: Array<{ title: string; note: string; files: InstructionFile[] }> = [
    { title: "Yours", note: "Every folder you open", files: files.filter((f) => f.scope === "user") },
    {
      title: `Above ${workspace?.name ?? "this folder"}`,
      note: "Folders that contain this one",
      files: files.filter((f) => f.scope === "parent"),
    },
    {
      title: workspace?.name ?? "This folder",
      note: "Only this folder",
      files: files.filter((f) => f.scope === "project" || f.scope === "local"),
    },
  ]

  return (
    <Page
      title="Instructions"
      summary={
        read.length > 0
          ? `The agent reads ${count(read.length, "file", "files")}, about ${number.format(total)} tokens, at the start of every chat${where}.`
          : "Nothing yet. Write down what the agent should always know, like how to run the tests or which conventions to keep."
      }
    >
      {read.length > 0 && <ReadOrder files={read} total={total} shade={shade} home={home} />}

      {groups.map((group) =>
        group.files.length === 0 && group.title.startsWith("Above") ? null : (
          <section key={group.title} className="mt-8" aria-labelledby={`group-${group.title}`}>
            <h2 id={`group-${group.title}`} className="flex items-baseline gap-2 pb-2 text-[13px] font-semibold">
              {group.title}
              <span className="font-normal text-muted-foreground">{group.note}</span>
            </h2>
            {group.files.length > 0 ? (
              <ul className="border-t border-border">
                {group.files.map((file) => (
                  <InstructionRow
                    key={file.path}
                    file={file}
                    home={home}
                    root={workspace?.root ?? null}
                    shade={shade(file)}
                    open={open === file.path}
                    onToggle={() => toggle(file.path)}
                    onOpen={() => setOpen(file.path)}
                  />
                ))}
              </ul>
            ) : (
              <Empty
                title="No folder open"
                body="Open a folder to give it instructions of its own, shared with the repo or kept to yourself."
                action={{ label: "Open folder…", run: () => void useWorkspace.getState().pickAndOpen() }}
              />
            )}
          </section>
        ),
      )}
    </Page>
  )
}

/** One strip of everything read, each file's share at its true size, in reading order. */
function ReadOrder({
  files,
  total,
  shade,
  home,
}: {
  files: InstructionFile[]
  total: number
  shade: (file: InstructionFile) => number | null
  home: string | null
}) {
  return (
    <figure className="mt-6">
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Share of each file">
        {files.map((file) => (
          <div
            key={file.path}
            title={`${shortPath(file.path, home, null)}: about ${number.format(tokensOf(file.content))} tokens`}
            className="h-full min-w-1 bg-brand"
            style={{ flexGrow: tokensOf(file.content), opacity: shade(file) ?? 1 }}
          />
        ))}
      </div>
      <figcaption className="mt-2 flex justify-between gap-4 text-xs text-muted-foreground">
        <span>Read in this order, top to bottom, before your first message</span>
        <span className="shrink-0 tabular-nums">{number.format(total)} tokens</span>
      </figcaption>
    </figure>
  )
}

function InstructionRow({
  file,
  home,
  root,
  shade,
  open,
  onToggle,
  onOpen,
}: {
  file: InstructionFile
  home: string | null
  root: string | null
  shade: number | null
  open: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const draft = useInstructions((s) => s.drafts[file.path])
  const working = useInstructions((s) => s.working[file.path])
  const failed = useInstructions((s) => s.failed[file.path])
  const editorId = `instructions-${file.path.replaceAll(/[^a-zA-Z0-9]/g, "-")}`
  const path = shortPath(file.path, home, root)

  const confirmDelete = async () => {
    if (await ipc.dialog.confirm(`The agent stops reading it in new chats.`, `Delete ${path}?`, "Delete")) {
      void useInstructions.getState().remove(file)
    }
  }

  return (
    <li className="border-b border-border">
      <div className="group flex items-start gap-3 py-3.5">
        <RowSummary
          open={open}
          onToggle={onToggle}
          detailsId={editorId}
          name={nameOf(file)}
          badge={<span className="truncate text-xs text-muted-foreground">{path}</span>}
          description={COPY[file.scope].description}
          dimmed={working === "deleting"}
          meta={<Meta file={file} shade={shade} unsaved={draft !== undefined} />}
        />
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {working === "deleting" ? (
            <Working label="Deleting…" />
          ) : file.exists ? (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More" ariaLabel={`More for ${path}`}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end" className="min-w-36">
                <MenuItem onSelect={() => void confirmDelete()} className="text-destructive [&_svg]:text-destructive">
                  <Trash2 /> Delete file
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : (
            !open && (
              <Button
                onClick={onOpen}
                aria-label={`Create ${path}`}
                className="bg-secondary px-3 text-foreground hover:bg-accent"
              >
                Create
              </Button>
            )
          )}
        </div>
      </div>

      {failed && !open && <RowError message={failed} />}
      {open && <Editor id={editorId} file={file} path={path} />}
    </li>
  )
}

function Meta({ file, shade, unsaved }: { file: InstructionFile; shade: number | null; unsaved: boolean }) {
  const pending = unsaved && <span className="text-foreground">Unsaved changes</span>
  if (!file.exists) {
    return (
      <>
        <span>Not created yet</span>
        {pending}
      </>
    )
  }
  return (
    <>
      {shade !== null && (
        <span aria-hidden className="size-2 rounded-[2px] bg-brand" style={{ opacity: shade }} />
      )}
      <span className="tabular-nums">{count(linesOf(file.content), "line", "lines")}</span>
      <span className="tabular-nums">about {number.format(tokensOf(file.content))} tokens</span>
      {file.modifiedMs !== null && <span>edited {relativeTime(file.modifiedMs)}</span>}
      {pending}
    </>
  )
}

function Editor({ id, file, path }: { id: string; file: InstructionFile; path: string }) {
  const draft = useInstructions((s) => s.drafts[file.path])
  const working = useInstructions((s) => s.working[file.path])
  const failed = useInstructions((s) => s.failed[file.path])
  const savedAt = useInstructions((s) => s.savedAt[file.path])
  const area = useRef<HTMLTextAreaElement>(null)
  const text = draft ?? file.content
  const dirty = draft !== undefined
  const canSave = dirty && !working && (file.exists || text.trim().length > 0)
  const { edit, discard, save } = useInstructions.getState()

  // Grows with its text up to the cap, then scrolls.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + 2}px`
  }, [text])

  useEffect(() => {
    if (!file.exists) area.current?.focus()
  }, [file.exists])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      if (canSave) void save(file)
    }
  }

  return (
    <div id={id} className="mb-4 ml-5 animate-message-in">
      <textarea
        ref={area}
        value={text}
        onChange={(e) => edit(file, e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={COPY[file.scope].placeholder}
        aria-label={`Contents of ${path}`}
        spellCheck={false}
        className="block max-h-[60vh] min-h-24 w-full resize-none rounded-lg border border-input bg-surface-sunken px-3.5 py-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-subtle-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="mt-2 flex items-center gap-3">
        <p
          aria-live="polite"
          className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", failed && "text-destructive")}
        >
          {failed
            ? failed
            : working === "saving"
              ? "Saving…"
              : dirty
                ? `Unsaved. ${isMac ? "⌘S" : "Ctrl+S"} saves to ${path}`
                : savedAt
                  ? `Saved. New chats read this version.`
                  : "Markdown, read as written. Chats already open keep the version they started with."}
        </p>
        {dirty && !working && (
          <Button onClick={() => discard(file.path)} className="px-2.5">
            {file.exists ? "Discard" : "Cancel"}
          </Button>
        )}
        {failed && failed.includes("changed on disk") && (
          <Button onClick={() => void useInstructions.getState().load()} className="px-2.5">
            Reload
          </Button>
        )}
        <Button
          onClick={() => void save(file)}
          disabled={!canSave}
          className="bg-brand px-3 text-brand-foreground hover:bg-brand/90 hover:text-brand-foreground"
        >
          {file.exists ? "Save" : "Create file"}
        </Button>
      </div>
    </div>
  )
}

function nameOf(file: InstructionFile) {
  switch (file.scope) {
    case "user":
      return "Personal"
    case "parent":
      return file.path.endsWith("CLAUDE.local.md") ? "Inherited, just you" : "Inherited"
    case "project":
      return "Shared with the repo"
    case "local":
      return "Just you"
  }
}

/** `CLAUDE.md` inside the open folder, `~/…` under home, the full path elsewhere. */
function shortPath(path: string, home: string | null, root: string | null) {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}
