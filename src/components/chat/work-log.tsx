import {
  Bot,
  Eye,
  Globe,
  Hammer,
  ListTodo,
  MessageCircle,
  Search,
  Smartphone,
  SquarePen,
  Terminal,
  Wrench,
} from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

import type { ToolAction } from "./activity"

/*
 * The work log: tool calls as quiet one-line rows (an icon, what was done, a
 * chevron), laid out the way T3 Code's timeline does it.
 */

/** T3 Code's pointer-over-a-window glyph, for the desktop-control tool. */
function DesktopIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ToolIcon({ action, className }: { action: ToolAction | "mixed"; className?: string }) {
  const props = { className, "aria-hidden": true }
  switch (action) {
    case "read":
      return <Eye {...props} />
    case "edit":
      return <SquarePen {...props} />
    case "command":
      return <Terminal {...props} />
    case "code-search":
      return <Search {...props} />
    case "search":
      return <Globe {...props} />
    case "browser":
      return <DesktopIcon className={className} />
    case "device":
      return <Smartphone {...props} />
    case "agent":
      return <Bot {...props} />
    case "todo":
      return <ListTodo {...props} />
    case "question":
      return <MessageCircle {...props} />
    case "mixed":
      return <Hammer {...props} />
    case "other":
      return <Wrench {...props} />
  }
}

type RowContent = {
  icon?: ReactNode
  label: ReactNode
  trailing?: ReactNode
}

function WorkLogLine({ icon, label, trailing }: RowContent) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-sm leading-relaxed">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon && <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>}
        <div className="min-w-0 flex-1 truncate text-muted-foreground">{label}</div>
      </div>
      {trailing}
    </div>
  )
}

const rowClassName =
  "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 py-0.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"

/** A row that only toggles something: a work group's header. */
export function WorkLogButton({
  icon,
  label,
  trailing,
  ...props
}: RowContent & Omit<ComponentProps<"button">, "className" | "children">) {
  return (
    <button {...props} type="button" className={cn(rowClassName, "cursor-pointer")}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} />
    </button>
  )
}

/** A row with detail underneath it; a div so the detail stays selectable. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  children,
  ...props
}: RowContent & Omit<ComponentProps<"div">, "className">) {
  return (
    <div {...props} className={cn(rowClassName, props.onClick && "cursor-pointer")}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} />
      {children}
    </div>
  )
}

/** What a row opens onto, indented under its label. */
export function WorkLogDetails({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-0.5 mb-1.5 ml-7 flex cursor-auto flex-col gap-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
