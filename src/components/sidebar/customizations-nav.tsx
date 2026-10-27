import { Blocks, BookOpen, Bot, Lightbulb, Plug, Server, Webhook, Wrench } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
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

export function CustomizationsNav() {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)

  return (
    <div className="shrink-0 border-t border-border px-2 pt-2 pb-3">
      <h2 className="flex items-center gap-2 px-1.5 pb-1 text-[13px] font-semibold">
        <Blocks className="size-3.5 text-muted-foreground" />
        Customizations
      </h2>
      <ul className="flex flex-col gap-px">
        {CUSTOMIZATIONS.map(({ id, label, icon: Icon }) => {
          const active = current.view.kind === "planned" && current.view.item === id
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => navigate({ view: { kind: "planned", item: id } })}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-sidebar-foreground/85 outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                  active && "bg-sidebar-selected text-sidebar-foreground",
                )}
              >
                <Icon className="size-3.5 text-muted-foreground" />
                {label}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
