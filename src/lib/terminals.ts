/**
 * The emulators behind terminal tabs: the user's shells (⌘T) and the terminals the
 * agent starts with its `terminal-access` tool. They live here rather than in React so
 * a process and its scrollback survive switching tabs, chats, or to a file view: views
 * only move a terminal's element in and out of the page.
 */
import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal } from "@xterm/xterm"
import { create } from "zustand"

import { ipc } from "@/lib/ipc"
import { isMac } from "@/lib/utils"

const PREFIX = "terminal:"

/** Tab keys for terminals; every other tab key is a tool call's id. */
export const isTerminalTab = (key: string) => key.startsWith(PREFIX)

/** Whether a key event comes from inside a terminal. */
export const isInTerminal = (target: EventTarget | null) => target instanceof Element && target.closest(".xterm") !== null

export interface TerminalTab {
  title: string
  /** Started by the agent's `terminal-access` tool rather than ⌘T. */
  agent: boolean
  running: boolean
}

/** Every open terminal tab by key, for the tab bar. */
export const useTerminalTabs = create<Record<string, TerminalTab>>()(() => ({}))

interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  pty: number
  opened: boolean
}

/**
 * Geist Mono for text; Nerd Font symbols (bundled, see styles.css) for the icons and
 * Powerline separators that prompts like powerlevel10k and starship print.
 */
const FONT_FAMILY = `"Geist Mono Variable", "Symbols Nerd Font Mono", ui-monospace, "SF Mono", Menlo, monospace`

/** The size the host gives agent terminals, until their tab is shown and fits itself. */
const AGENT_SIZE = { cols: 120, rows: 32 }

const entries = new Map<string, Entry>()
let shells = 0

export const terminalKey = (pty: number) => `${PREFIX}${pty}`

/** Starts the user's shell in a new terminal; returns the tab key. `onExit` runs when the shell ends by itself. */
export async function createShell(onExit: (key: string) => void): Promise<string> {
  await fontsReady()
  const pty = await ipc.terminal.open(80, 24)
  const n = ++shells
  return adopt(pty, { title: n === 1 ? "Terminal" : `Terminal ${n}`, agent: false, cols: 80, rows: 24 }, onExit)
}

/**
 * Shows a terminal the agent started; returns its tab key. Its tab stays open after
 * the command ends, so its output can still be read. Showing one twice is harmless.
 */
export async function adoptAgentTerminal(pty: number, title: string): Promise<string> {
  const key = terminalKey(pty)
  if (entries.has(key)) return key
  await fontsReady()
  return adopt(pty, { title, agent: true, ...AGENT_SIZE })
}

async function adopt(
  pty: number,
  { title, agent, cols, rows }: { title: string; agent: boolean; cols: number; rows: number },
  onExit?: (key: string) => void,
): Promise<string> {
  const key = terminalKey(pty)
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: 12,
    lineHeight: 1.2,
    cols,
    rows,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    // For the Unicode 11 widths below, so emoji and wide characters take two cells.
    allowProposedApi: true,
    theme: theme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = "11"
  const host = document.createElement("div")
  host.style.height = "100%"
  entries.set(key, { term, fit, host, pty, opened: false })
  useTerminalTabs.setState({ [key]: { title, agent, running: true } })

  // ⌘ shortcuts (and ⌘/Ctrl+T) belong to the app; everything else, Ctrl+C included, goes to the process.
  term.attachCustomKeyEventHandler((e) => {
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyT") return false
    return !(isMac && e.metaKey)
  })
  term.onData((data) => isRunning(key) && void ipc.terminal.write(pty, data))
  term.onResize(({ cols, rows }) => isRunning(key) && void ipc.terminal.resize(pty, cols, rows))
  // Shells name their tab after what's running; the agent's keep the title it gave.
  if (!agent) term.onTitleChange((title) => title && setTab(key, { title }))

  const exited = (code: number | null) => {
    if (!entries.has(key)) return
    setTab(key, { running: false })
    if (onExit) {
      onExit(key)
    } else {
      const status = code === null ? "Process exited" : `Process exited with code ${code}`
      term.write(`\r\n\x1b[2m[${status}]\x1b[0m\r\n`)
    }
  }
  try {
    await ipc.terminal.attach(pty, (bytes) => term.write(bytes), exited)
  } catch (error) {
    disposeTerminal(key)
    throw error
  }
  return key
}

const isRunning = (key: string) => useTerminalTabs.getState()[key]?.running === true

function setTab(key: string, change: Partial<TerminalTab>) {
  useTerminalTabs.setState((tabs) => (tabs[key] ? { [key]: { ...tabs[key], ...change } } : {}))
}

/** xterm measures its cell size once, so the fonts must be ready first. */
async function fontsReady() {
  await Promise.all([
    document.fonts.load(`12px "Geist Mono Variable"`),
    document.fonts.load(`12px "Symbols Nerd Font Mono"`, "\ue0b0"),
  ]).catch(() => {})
}

/** Moves the terminal into `container` and sizes it to fit. */
export function attachTerminal(key: string, container: HTMLElement) {
  const entry = entries.get(key)
  if (!entry) return
  container.appendChild(entry.host)
  if (!entry.opened) {
    entry.term.open(entry.host)
    entry.opened = true
    // WebGL draws box-drawing and Powerline shapes itself, so prompt segments join up; it's
    // also much faster. Falls back to the DOM renderer if WebGL is unavailable or lost.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      entry.term.loadAddon(webgl)
    } catch {
      // DOM renderer.
    }
  }
  fitTerminal(key)
}

export function detachTerminal(key: string) {
  entries.get(key)?.host.remove()
}

/** Resizes to the container, unless it's hidden. */
export function fitTerminal(key: string) {
  const entry = entries.get(key)
  if (entry?.opened && entry.host.clientWidth > 0 && entry.host.clientHeight > 0) entry.fit.fit()
}

export function focusTerminal(key: string) {
  entries.get(key)?.term.focus()
}

/** Ends the shell and drops its emulator. */
export function disposeTerminal(key: string) {
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  void ipc.terminal.close(entry.pty)
  entry.host.remove()
  entry.term.dispose()
  useTerminalTabs.setState((tabs) => {
    const { [key]: _, ...rest } = tabs
    return rest
  }, true)
}

export function disposeAllTerminals() {
  for (const key of [...entries.keys()]) disposeTerminal(key)
}

function theme() {
  const rgb = (name: string) => `rgb(${channels(name).join(", ")})`
  return {
    background: rgb("--surface"),
    foreground: rgb("--foreground"),
    cursor: rgb("--foreground"),
    cursorAccent: rgb("--surface"),
    selectionBackground: `rgba(${channels("--brand").join(", ")}, 0.3)`,
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

let canvas: CanvasRenderingContext2D | null = null

/** A colour variable's red, green and blue: they're written in oklch, which xterm can't parse. */
function channels(name: string): [number, number, number] {
  canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!canvas) return [0, 0, 0]
  canvas.clearRect(0, 0, 1, 1)
  canvas.fillStyle = "#000"
  canvas.fillStyle = cssVar(name)
  canvas.fillRect(0, 0, 1, 1)
  const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}
