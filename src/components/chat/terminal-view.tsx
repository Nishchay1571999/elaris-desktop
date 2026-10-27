import { useEffect, useRef } from "react"

import { attachTerminal, detachTerminal, fitTerminal, focusTerminal } from "@/lib/terminals"
import { cn } from "@/lib/utils"

/** A terminal tab. Every open one stays mounted (hidden when not in front) so it keeps its size. */
export function TerminalView({ tabKey, active }: { tabKey: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    attachTerminal(tabKey, el)
    // Also fires when the tab comes to the front, since it was hidden at zero size.
    const observer = new ResizeObserver(() => fitTerminal(tabKey))
    observer.observe(el)
    return () => {
      observer.disconnect()
      detachTerminal(tabKey)
    }
  }, [tabKey])

  useEffect(() => {
    if (active) focusTerminal(tabKey)
  }, [active, tabKey])

  return (
    <div className={cn("min-h-0 flex-1 border-t border-border bg-surface py-2 pl-4 pr-1", !active && "hidden")}>
      <div ref={ref} className="h-full" />
    </div>
  )
}
