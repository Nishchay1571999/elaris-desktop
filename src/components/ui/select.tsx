import { Select as S } from "radix-ui"
import { Check, ChevronDown } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** A compact dropdown for settings rows. */
export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: V
  options: Array<{ value: V; label: ReactNode; hint?: string }>
  onChange: (value: V) => void
  className?: string
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <S.Trigger
        aria-label={label}
        className={cn(
          "inline-flex h-7 min-w-36 items-center justify-between gap-2 rounded-md border border-input bg-surface-sunken px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        <S.Value />
        <S.Icon>
          <ChevronDown className="size-3.5 text-subtle-foreground" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-50 min-w-(--radix-select-trigger-width) rounded-lg border border-border-strong bg-popover p-1 text-[13px] text-popover-foreground shadow-xl"
        >
          <S.Viewport>
            {options.map((option) => (
              <S.Item
                key={option.value}
                value={option.value}
                className="flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-7 outline-none select-none data-[highlighted]:bg-accent relative"
              >
                <S.ItemIndicator className="absolute left-2 flex size-3.5 items-center justify-center">
                  <Check className="size-3.5 text-muted-foreground" />
                </S.ItemIndicator>
                <span>
                  <S.ItemText>{option.label}</S.ItemText>
                  {option.hint && <span className="block text-[11px] text-subtle-foreground">{option.hint}</span>}
                </span>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}
