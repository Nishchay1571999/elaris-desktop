import { Command as Cmdk } from "cmdk"
import { Check, LoaderCircle } from "lucide-react"
import { useState } from "react"

import { Kbd } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { type QuickItem, useQuickInput } from "@/stores/quick-input"

/**
 * The one quick pick / input box, opened from code with `pick()`, `pickMany()`
 * or `input()` in `stores/quick-input`. Looks like the command palette.
 */
export function QuickInput() {
  const request = useQuickInput((s) => s.request)
  const cancel = useQuickInput((s) => s.cancel)

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && cancel()}>
      <DialogContent top className="overflow-hidden p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{request?.placeholder ?? "Quick input"}</DialogTitle>
        <DialogDescription className="sr-only">{request?.kind === "input" ? request.prompt : "Choose an item"}</DialogDescription>
        {/* Keyed so each request starts fresh. */}
        {request?.kind === "pick" && <PickBody key={request.id} />}
        {request?.kind === "input" && <InputBody key={request.id} />}
      </DialogContent>
    </Dialog>
  )
}

function PickBody() {
  const request = useQuickInput((s) => (s.request?.kind === "pick" ? s.request : null))
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  if (!request) return null
  const items = request.items
  const groups = items ? [...new Set(items.map((i) => i.group ?? ""))] : []

  const choose = (index: number) => {
    if (!items) return
    if (!request.multiple) return request.resolve(items[index].value)
    setChosen((s) => {
      const next = new Set(s)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  return (
    <Cmdk label={request.placeholder} loop className="flex max-h-[min(60vh,28rem)] flex-col">
      <Cmdk.Input
        autoFocus
        placeholder={request.placeholder}
        onKeyDown={(e) => {
          // With several to pick, ⌘↩ confirms the lot.
          if (request.multiple && e.key === "Enter" && (e.metaKey || e.ctrlKey) && items) {
            e.preventDefault()
            request.resolve([...chosen].map((i) => items[i].value))
          }
        }}
        className="h-11 w-full shrink-0 border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-subtle-foreground"
      />
      <Cmdk.List className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle-foreground">
        {!items ? (
          <p className="flex items-center gap-2 px-3 py-6 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading…
          </p>
        ) : (
          <>
            <Cmdk.Empty className="px-3 py-8 text-center text-muted-foreground">
              {request.error ?? (items.length ? "Nothing matches" : "Nothing to choose from")}
            </Cmdk.Empty>
            {groups.map((group) => (
              <Cmdk.Group key={group} heading={group || undefined}>
                {items.map((item, index) =>
                  (item.group ?? "") === group ? (
                    <PickItem
                      key={index}
                      item={item}
                      index={index}
                      checked={request.multiple ? chosen.has(index) : undefined}
                      onSelect={() => choose(index)}
                    />
                  ) : null,
                )}
              </Cmdk.Group>
            ))}
          </>
        )}
      </Cmdk.List>
      {request.multiple && (
        <footer className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-subtle-foreground">
          <span>
            <Kbd>↩</Kbd> to toggle
          </span>
          <span>
            <Kbd>⌘↩</Kbd> to confirm {chosen.size > 0 && `(${chosen.size})`}
          </span>
        </footer>
      )}
    </Cmdk>
  )
}

function PickItem({
  item,
  index,
  checked,
  onSelect,
}: {
  item: QuickItem<unknown>
  index: number
  checked: boolean | undefined
  onSelect: () => void
}) {
  const Icon = item.icon
  return (
    <Cmdk.Item
      // Unique even when labels repeat; the label leads so it's what's searched.
      value={`${item.label} ${item.hint ?? ""} \u0001${index}`}
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 outline-none select-none data-[selected=true]:bg-accent [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {checked !== undefined && (
        <span
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-border-strong",
            checked && "border-brand bg-brand text-brand-foreground",
          )}
        >
          {checked && <Check className="size-3" />}
        </span>
      )}
      {Icon && <Icon />}
      <span className="min-w-0 shrink-0 truncate">{item.label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{item.hint}</span>
    </Cmdk.Item>
  )
}

function InputBody() {
  const request = useQuickInput((s) => (s.request?.kind === "input" ? s.request : null))
  const [value, setValue] = useState(request?.value ?? "")
  if (!request) return null
  const problem = value.trim() ? (request.validate?.(value.trim()) ?? null) : null

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim() && !problem) request.resolve(value)
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        placeholder={request.placeholder}
        aria-invalid={!!problem}
        className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-subtle-foreground"
      />
      <p className={cn("px-4 py-2 text-xs", problem ? "text-destructive" : "text-subtle-foreground")}>
        {problem ?? request.prompt ?? "Press Enter to confirm or Escape to cancel"}
      </p>
    </form>
  )
}
