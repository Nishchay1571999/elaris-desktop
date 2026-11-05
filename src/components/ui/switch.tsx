import { Switch as S } from "radix-ui"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:bg-brand",
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-3.5 translate-x-px rounded-full bg-foreground shadow-sm transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-brand-foreground" />
    </S.Root>
  )
}
