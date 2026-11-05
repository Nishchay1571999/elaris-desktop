import { Dialog as D } from "radix-ui"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

export const Dialog = D.Root
export const DialogTitle = D.Title
export const DialogDescription = D.Description
export const DialogClose = D.Close

/** A centred panel over a dimmed app. `top` pins it near the top, as a palette sits. */
export function DialogContent({
  className,
  top = false,
  children,
  ...props
}: ComponentProps<typeof D.Content> & { top?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <D.Content
        className={cn(
          "fixed left-1/2 z-50 w-[min(92vw,36rem)] -translate-x-1/2 rounded-xl border border-border-strong bg-popover text-[13px] text-popover-foreground shadow-2xl outline-none animate-dock-in",
          top ? "top-[12vh]" : "top-1/2 -translate-y-1/2",
          className,
        )}
        {...props}
      >
        {children}
      </D.Content>
    </D.Portal>
  )
}
