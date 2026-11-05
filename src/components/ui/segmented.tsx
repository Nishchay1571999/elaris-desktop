import { ToggleGroup as T } from "radix-ui"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** A row of mutually exclusive options, like Light / Dark / System. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: V
  options: Array<{ value: V; label: ReactNode; icon?: ReactNode }>
  onChange: (value: V) => void
  className?: string
}) {
  return (
    <T.Root
      type="single"
      aria-label={label}
      value={value}
      // Radix sends "" when the active item is pressed again; keep the choice.
      onValueChange={(v) => v && onChange(v as V)}
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5", className)}
    >
      {options.map((option) => (
        <T.Item
          key={option.value}
          value={option.value}
          className="flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=on]:bg-surface-elevated data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:size-3.5"
        >
          {option.icon}
          {option.label}
        </T.Item>
      ))}
    </T.Root>
  )
}
