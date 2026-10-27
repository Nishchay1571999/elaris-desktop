import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { useWorkspace } from "@/stores/workspace"

/** Share of the bar one opening step is worth (the store counts four). */
const STEP = 0.25

/**
 * A thin brand-coloured bar across the top of the window while a project
 * opens, like YouTube's page-change bar. It jumps as each step finishes and
 * creeps toward the next one in between, so it never sits still or claims a
 * step it hasn't reached.
 */
export function OpeningBar() {
  const opening = useWorkspace((s) => s.opening)
  const [width, setWidth] = useState(0)
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle")
  const wasOpening = useRef(false)

  useEffect(() => {
    if (opening !== null) {
      wasOpening.current = true
      setPhase("running")
      setWidth((w) => Math.max(w, 8, opening * 100))
      // Trickle toward just short of the next step.
      const cap = Math.min(95, (opening + STEP) * 100 - 2)
      const timer = setInterval(() => setWidth((w) => w + Math.max(0, cap - w) * 0.08), 200)
      return () => clearInterval(timer)
    }
    if (!wasOpening.current) return
    wasOpening.current = false
    setWidth(100)
    setPhase("done")
    const timer = setTimeout(() => {
      setPhase("idle")
      setWidth(0)
    }, 450)
    return () => clearTimeout(timer)
  }, [opening])

  return (
    <div
      role="progressbar"
      aria-label="Opening project"
      aria-hidden={phase === "idle"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      <div
        className={cn(
          "h-full bg-brand shadow-[0_0_8px_var(--color-brand)]",
          phase === "idle" ? "opacity-0 transition-none" : "transition-[width] duration-200 ease-out",
          phase === "done" && "opacity-0 transition-[width,opacity] delay-[0ms,200ms] duration-200",
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}
