import { type DependencyList, useEffect, useLayoutEffect, useRef } from "react"

/** Keeps a scroller at the bottom as content arrives, but only while the user is already there. */
export function useFollowBottom<T extends HTMLElement>(deps: DependencyList) {
  const scroller = useRef<T>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, deps)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  return scroller
}
