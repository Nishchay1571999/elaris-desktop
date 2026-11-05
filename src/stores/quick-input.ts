import type { LucideIcon } from "lucide-react"
import { create } from "zustand"

/** One choice in a quick pick. */
export interface QuickItem<T> {
  label: string
  /** Dimmed text after the label. */
  hint?: string
  /** A heading the item is grouped under. */
  group?: string
  icon?: LucideIcon
  value: T
}

interface PickRequest {
  kind: "pick"
  id: number
  placeholder: string
  items: QuickItem<unknown>[] | null
  error: string | null
  /** Pick several, confirmed with Enter on the input. */
  multiple: boolean
  resolve: (value: unknown) => void
}

interface InputRequest {
  kind: "input"
  id: number
  placeholder: string
  /** Explains what the text is for, under the box. */
  prompt?: string
  value: string
  validate?: (value: string) => string | null
  resolve: (value: string | null) => void
}

type Request = PickRequest | InputRequest

interface QuickInputState {
  request: Request | null
  /** Closes whatever is open, resolving it with nothing. */
  cancel: () => void
}

export const useQuickInput = create<QuickInputState>()((set, get) => ({
  request: null,
  cancel: () => {
    const request = get().request
    set({ request: null })
    if (request?.kind === "pick") request.resolve(request.multiple ? [] : null)
    else request?.resolve(null)
  },
}))

let nextId = 1

/** Clears request `id` if it's still the open one. */
const close = (id: number) => useQuickInput.setState((s) => (s.request?.id === id ? { request: null } : s))

/** Replaces anything already open, which then resolves with nothing. */
function open(request: Request) {
  useQuickInput.getState().cancel()
  useQuickInput.setState({ request })
}

/**
 * Asks the user to choose one item, VS Code quick-pick style. `items` may be
 * a promise: the picker opens at once and fills in when it resolves.
 * Resolves to the chosen value, or null if dismissed.
 */
export function pick<T>(items: QuickItem<T>[] | Promise<QuickItem<T>[]>, placeholder: string): Promise<T | null> {
  return new Promise((resolve) => {
    const request: PickRequest = {
      kind: "pick",
      id: nextId++,
      placeholder,
      items: Array.isArray(items) ? (items as QuickItem<unknown>[]) : null,
      error: null,
      multiple: false,
      resolve: (value) => {
        close(request.id)
        resolve(value as T | null)
      },
    }
    open(request)
    if (!Array.isArray(items)) {
      items.then(
        (loaded) => fill(request, { items: loaded as QuickItem<unknown>[] }),
        (error: unknown) => fill(request, { items: [], error: String(error) }),
      )
    }
  })
}

/** Like [`pick`], choosing any number of items. Resolves to them, or `[]` if dismissed. */
export function pickMany<T>(items: QuickItem<T>[] | Promise<QuickItem<T>[]>, placeholder: string): Promise<T[]> {
  return new Promise((resolve) => {
    const request: PickRequest = {
      kind: "pick",
      id: nextId++,
      placeholder,
      items: Array.isArray(items) ? (items as QuickItem<unknown>[]) : null,
      error: null,
      multiple: true,
      resolve: (value) => {
        close(request.id)
        resolve((value as T[] | null) ?? [])
      },
    }
    open(request)
    if (!Array.isArray(items)) {
      items.then(
        (loaded) => fill(request, { items: loaded as QuickItem<unknown>[] }),
        (error: unknown) => fill(request, { items: [], error: String(error) }),
      )
    }
  })
}

function fill(request: PickRequest, patch: Partial<PickRequest>) {
  useQuickInput.setState((s) => (s.request?.id === request.id ? { request: { ...(s.request as PickRequest), ...patch } } : s))
}

/** Asks for a line of text. Resolves to it (trimmed), or null if dismissed. */
export function input(options: {
  placeholder: string
  prompt?: string
  value?: string
  validate?: (value: string) => string | null
}): Promise<string | null> {
  return new Promise((resolve) => {
    const request: InputRequest = {
      kind: "input",
      id: nextId++,
      value: "",
      ...options,
      resolve: (value) => {
        close(request.id)
        resolve(value === null ? null : value.trim())
      },
    }
    open(request)
  })
}
