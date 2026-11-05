import { isMac } from "@/lib/utils"

/**
 * Shortcuts are written like `mod+shift+k`: modifiers, then one key. `mod` is ⌘ on
 * macOS and Ctrl elsewhere. Keys match on `KeyboardEvent.code`, so ⌥ and the keyboard
 * layout don't change the letter.
 */
export type Binding = string

const CODE_OF: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  enter: "Enter",
  escape: "Escape",
  backspace: "Backspace",
  tab: "Tab",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}
const KEY_OF = Object.fromEntries(Object.entries(CODE_OF).map(([key, code]) => [code, key]))

function codeOf(key: string): string {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return CODE_OF[key] ?? key
}

function keyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase()
  return KEY_OF[code] ?? null
}

interface Parsed {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  code: string
}

function parse(binding: Binding): Parsed {
  const parts = binding.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  // `ctrl` on macOS is its own key; elsewhere it's the same as `mod`.
  const ctrl = parts.includes("ctrl")
  return {
    mod: parts.includes("mod") || (!isMac && ctrl),
    ctrl: isMac && ctrl,
    alt: parts.includes("alt"),
    shift: parts.includes("shift"),
    // `+` itself can't be a key here; `=` with shift stands in for it.
    code: codeOf(key || "+"),
  }
}

/**
 * Whether the event is this shortcut. On macOS `mod` takes Ctrl as well as ⌘, as the
 * app always has, unless `strictMod` (inside a terminal, where Ctrl belongs to the shell).
 */
export function matches(e: KeyboardEvent, binding: Binding, strictMod = false): boolean {
  const b = parse(binding)
  if (e.code !== b.code || e.altKey !== b.alt || e.shiftKey !== b.shift) return false
  if (!isMac) return e.ctrlKey === b.mod && !e.metaKey
  if (b.ctrl) return e.ctrlKey && e.metaKey === b.mod
  if (!b.mod) return !e.metaKey && !e.ctrlKey
  return strictMod ? e.metaKey && !e.ctrlKey : e.metaKey !== e.ctrlKey
}

/** The shortcut a key press would record, or null for a bare modifier or a key with no modifier. */
export function fromEvent(e: KeyboardEvent): Binding | null {
  const key = keyOf(e.code)
  if (!key) return null
  const mod = isMac ? e.metaKey : e.ctrlKey
  const ctrl = isMac && e.ctrlKey
  // Function keys can stand alone; anything else needs ⌘/Ctrl so typing isn't caught.
  if (!mod && !ctrl && !/^f\d/.test(key)) return null
  return [ctrl && "ctrl", mod && "mod", e.altKey && "alt", e.shiftKey && "shift", key].filter(Boolean).join("+")
}

const MAC_SYMBOL: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
const PC_NAME: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" }
const KEY_LABEL: Record<string, string> = {
  enter: "↩",
  escape: "Esc",
  backspace: "⌫",
  tab: "⇥",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
}

/** `mod+shift+k` as people read it: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere. */
export function formatBinding(binding: Binding | null | undefined): string {
  if (!binding) return ""
  const parts = binding.toLowerCase().split("+")
  const key = parts.pop() ?? ""
  const label = KEY_LABEL[key] ?? key.toUpperCase()
  // macOS order: ⌃⌥⇧⌘.
  if (isMac) {
    const order = ["ctrl", "alt", "shift", "mod"]
    return [...order.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOL[m]), label].join("")
  }
  const order = ["mod", "ctrl", "alt", "shift"]
  const mods = [...new Set(order.filter((m) => parts.includes(m)).map((m) => PC_NAME[m]))]
  return [...mods, label].join("+")
}
