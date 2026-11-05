import { useCallback, useEffect, useRef, useState } from "react"

import { fetchFresh, peek } from "@/lib/gh-cache"
import { useGitHub } from "@/stores/github"

/** Within this, a remembered answer is used without asking GitHub again. */
const FRESH_MS = 30_000

/**
 * A GitHub read through the cache: what's remembered shows at once, and a fresh copy
 * replaces it in the background. `loading` is only true with nothing to show yet;
 * `revalidating` is the quiet background refresh. `key` null skips the read.
 */
export function useGh<T>(key: string | null, fetcher: () => Promise<T>, { keepPrevious = false } = {}) {
  const [data, setData] = useState<T | undefined>(() => (key ? peek<T>(key)?.value : undefined))
  const [error, setError] = useState<string | null>(null)
  const [revalidating, setRevalidating] = useState(false)
  const [nonce, setNonce] = useState(0)
  const forced = useRef(false)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!key) return
    let live = true
    const hit = peek<T>(key)
    setData((previous) => hit?.value ?? (keepPrevious ? previous : undefined))
    setError(null)
    const force = forced.current
    forced.current = false
    if (hit && !force && Date.now() - hit.at < FRESH_MS) {
      setRevalidating(false)
      return
    }
    setRevalidating(true)
    fetchFresh(key, fetcherRef.current)
      .then((value) => live && setData(value))
      .catch((e) => live && setError(useGitHub.getState().handleError(e)))
      .finally(() => live && setRevalidating(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keepPrevious is fixed per call site
  }, [key, nonce])

  /** Asks GitHub again now, keeping what's shown until the answer arrives. */
  const refresh = useCallback(() => {
    forced.current = true
    setNonce((n) => n + 1)
  }, [])

  return { data, error, loading: data === undefined && !error, revalidating, refresh }
}
