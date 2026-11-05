import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * A hairline that says "checking for changes" without hiding what's shown: a short brand
 * segment crosses it while `active`. It waits a moment before showing, so a quick answer
 * from GitHub never flickers it, and holds briefly once shown so it reads as a sweep.
 */
export function ActivityBar({ active, label = "Checking GitHub for changes", className }: { active: boolean; label?: string; className?: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(active), active ? 180 : 350)
    return () => clearTimeout(timer)
  }, [active])

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-hidden={!shown}
      aria-busy={shown}
      className={cn("pointer-events-none h-0.5 overflow-hidden transition-opacity duration-300", shown ? "opacity-100" : "opacity-0", className)}
    >
      <div className="h-full w-1/4 rounded-full bg-brand animate-sync-sweep motion-reduce:w-full motion-reduce:animate-pulse motion-reduce:bg-brand/50" />
    </div>
  )
}
