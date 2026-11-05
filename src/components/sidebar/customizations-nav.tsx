import { Blocks, BookOpen, Bot, ChevronRight, Lightbulb, Plug, Server, Webhook, Wrench } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { usePreferences } from "@/stores/preferences"
import { type CustomizationId, useCurrent, useUi } from "@/stores/ui"

export const CUSTOMIZATIONS: Array<{ id: CustomizationId; label: string; icon: LucideIcon; blurb: string }> = [
  { id: "plugins", label: "Plugins", icon: Plug, blurb: "Install bundles of skills, agents and tools shared by others." },
  { id: "mcp", label: "MCP Servers", icon: Server, blurb: "Connect Model Context Protocol servers so the agent can use your services." },
  { id: "skills", label: "Skills", icon: Lightbulb, blurb: "Reusable instructions the agent loads when a task calls for them." },
  { id: "instructions", label: "Instructions", icon: BookOpen, blurb: "Project and personal guidance the agent always follows." },
  { id: "agents", label: "Agents", icon: Bot, blurb: "Specialised sub-agents with their own prompts and tool access." },
  { id: "hooks", label: "Hooks", icon: Webhook, blurb: "Run your own commands before or after the agent acts." },
  { id: "tools", label: "Tools", icon: Wrench, blurb: "Choose which shell, file and git tools the agent may use." },
]

/** The Customizations pages; the header folds the list away, and the app remembers which. */
export function CustomizationsNav() {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)
  const open = usePreferences((s) => s.customizationsOpen)
  const setPreferences = usePreferences((s) => s.set)
  const activeItem = current.view.kind === "planned" ? current.view.item : null
  const ActiveIcon = CUSTOMIZATIONS.find((c) => c.id === activeItem)?.icon

  return (
    <div className="shrink-0 border-t border-border px-2 py-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="customizations-list"
        onClick={() => setPreferences({ customizationsOpen: !open })}
        className="group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-sidebar-foreground/90 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <Blocks className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">Customizations</span>
        {/* Folded, the page you're on still shows. */}
        {!open && ActiveIcon && <ActiveIcon aria-hidden className="size-3.5 text-brand" />}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150 group-hover:text-muted-foreground",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul id="customizations-list" className="flex flex-col gap-0.5 pt-0.5 pb-1">
          {CUSTOMIZATIONS.map(({ id, label, icon: Icon }) => {
            const active = activeItem === id
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => navigate({ view: { kind: "planned", item: id } })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-foreground/75 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                    active && "bg-sidebar-selected font-medium text-sidebar-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {label}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
