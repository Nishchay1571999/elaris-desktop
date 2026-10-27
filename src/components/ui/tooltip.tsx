import { Tooltip as T } from "radix-ui"
import type { ReactNode } from "react"

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </T.Provider>
  )
}

export function Tooltip({
  label,
  side = "bottom",
  children,
}: {
  label: ReactNode
  side?: "top" | "bottom" | "left" | "right"
  children: ReactNode
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-64 rounded-md border border-border-strong bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
