import { PlannedTag } from "@/components/ui/button"
import { CUSTOMIZATIONS } from "@/components/sidebar/customizations-nav"
import type { CustomizationId } from "@/stores/ui"

export function PlannedPage({ item }: { item: CustomizationId }) {
  const entry = CUSTOMIZATIONS.find((c) => c.id === item)!
  const Icon = entry.icon

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-border-strong bg-surface-elevated">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          {entry.label} <PlannedTag />
        </h1>
        <p className="text-sm text-muted-foreground">{entry.blurb}</p>
      </div>
    </div>
  )
}
