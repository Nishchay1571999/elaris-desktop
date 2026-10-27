import { type ComponentProps, forwardRef, type ReactNode } from "react"

import { cn } from "@/lib/utils"

import { Tooltip } from "./tooltip"

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 aria-disabled:opacity-45 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"

export const Button = forwardRef<HTMLButtonElement, ComponentProps<"button">>(function Button(
  { className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(base, "h-7 px-2", className)} {...props} />
})

/** Square icon button; `label` doubles as aria-label and tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { label: ReactNode; ariaLabel?: string; side?: "top" | "bottom" | "left" | "right" }
>(function IconButton({ label, ariaLabel, side, className, type = "button", ...props }, ref) {
  return (
    <Tooltip label={label} side={side}>
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        className={cn(base, "size-7", className)}
        {...props}
      />
    </Tooltip>
  )
})

/** Marks a visible-but-unbuilt feature, per the design system. */
export function PlannedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-border-strong px-1.5 py-px text-[10px] font-medium tracking-wide text-subtle-foreground uppercase",
        className,
      )}
    >
      Planned
    </span>
  )
}

/** Keyboard hint like ⌘N. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded border border-border-strong px-1 font-mono text-[10.5px] leading-4 text-subtle-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  )
}
