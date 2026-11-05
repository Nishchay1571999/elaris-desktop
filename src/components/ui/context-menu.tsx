import { ContextMenu as C } from "radix-ui"
import { ChevronRight } from "lucide-react"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

import { itemClass, menuContentClass } from "./menu"

/** Right-click menus, styled like `Menu`. */
export const ContextMenu = C.Root
export const ContextMenuTrigger = C.Trigger
export const ContextMenuSub = C.Sub

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof C.Content>) {
  return (
    <C.Portal>
      <C.Content className={cn(menuContentClass, className)} {...props} />
    </C.Portal>
  )
}

export function ContextMenuItem({ className, ...props }: ComponentProps<typeof C.Item>) {
  return <C.Item className={cn(itemClass, className)} {...props} />
}

export function ContextMenuSeparator() {
  return <C.Separator className="my-1 h-px bg-border" />
}

export function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof C.SubTrigger>) {
  return (
    <C.SubTrigger className={cn(itemClass, "data-[state=open]:bg-accent", className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </C.SubTrigger>
  )
}

export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof C.SubContent>) {
  return (
    <C.Portal>
      <C.SubContent className={cn(menuContentClass, className)} {...props} />
    </C.Portal>
  )
}
