import { DropdownMenu as M } from "radix-ui"
import { Check } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

export const Menu = M.Root
export const MenuTrigger = M.Trigger

export function MenuContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={6}
        align="start"
        className={cn(
          "z-50 min-w-48 rounded-lg border border-border-strong bg-popover p-1 text-[13px] text-popover-foreground shadow-xl",
          className,
        )}
        {...props}
      />
    </M.Portal>
  )
}

const itemClass =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground"

export function MenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return <M.Item className={cn(itemClass, className)} {...props} />
}

export function MenuCheckItem({
  checked,
  children,
  ...props
}: ComponentProps<typeof M.Item> & { checked: boolean; children: ReactNode }) {
  return (
    <M.Item className={itemClass} {...props}>
      <span className="flex size-3.5 items-center justify-center">{checked && <Check />}</span>
      {children}
    </M.Item>
  )
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2 py-1 text-[11px] text-subtle-foreground", className)} {...props} />
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />
}
