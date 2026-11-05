/**
 * Every GitHub read, remembered: in memory, and in localStorage so the lists and pages
 * are there at once after a restart. Reads show what's remembered and revalidate in the
 * background (`useGh`); actions mark what they touched stale with `invalidate`.
 */

interface Entry {
  at: number
  value: unknown
}

const STORE_KEY = "elaris.gh-cache.v1"
const MAX_ENTRIES = 400
/** Bigger values (long diffs) stay in memory only. */
const MAX_PERSISTED_CHARS = 400_000

const entries = new Map<string, Entry>(load())
const inflight = new Map<string, Promise<unknown>>()

function load(): Array<[string, Entry]> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Array<[string, Entry]>) : []
  } catch {
    return []
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const kept = [...entries]
      .filter(([, e]) => JSON.stringify(e.value).length <= MAX_PERSISTED_CHARS)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_ENTRIES)
    // Out of room: keep halving, newest first.
    for (let n = kept.length; n > 0; n = Math.floor(n / 2)) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(kept.slice(0, n)))
        return
      } catch {
        /* try fewer */
      }
    }
  }, 500)
}

export function peek<T>(key: string): { value: T; at: number } | undefined {
  const entry = entries.get(key)
  return entry && { value: entry.value as T, at: entry.at }
}

export function put(key: string, value: unknown) {
  entries.set(key, { at: Date.now(), value })
  scheduleSave()
}

/** Asks GitHub now (one request per key at a time) and remembers the answer. */
export function fetchFresh<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const request = fetcher()
    .then((value) => {
      put(key, value)
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

/** The remembered value if it's younger than `maxAge`, otherwise a fresh one. */
export async function cached<T>(key: string, fetcher: () => Promise<T>, maxAge = 60_000): Promise<T> {
  const hit = peek<T>(key)
  if (hit && Date.now() - hit.at < maxAge) return hit.value
  return fetchFresh(key, fetcher)
}

/** Marks every entry whose key starts with one of `prefixes` stale; it still shows until replaced. */
export function invalidate(...prefixes: string[]) {
  for (const [key, entry] of entries) if (prefixes.some((p) => key.startsWith(p))) entry.at = 0
  scheduleSave()
}
