import { X } from "lucide-react"
import { useEffect, useState } from "react"

import type { RuleBehavior } from "@/bindings/RuleBehavior"
import { count, Empty, LoadingRows, Page, RowError } from "@/components/customizations/list-parts"
import { IconButton } from "@/components/ui/button"
import { errorMessage, ipc } from "@/lib/ipc"
import { otherRules, ruleFor, TOOL_GROUPS, TOOLS, type ToolEntry, toolState } from "@/lib/tool-catalog"
import { cn } from "@/lib/utils"
import { useTools } from "@/stores/tools"
import { useWorkspace } from "@/stores/workspace"

const CHOICES: Array<{ id: RuleBehavior; label: string }> = [
  { id: "allow", label: "Allow" },
  { id: "ask", label: "Ask" },
  { id: "deny", label: "Off" },
]
const label = (b: RuleBehavior) => CHOICES.find((c) => c.id === b)!.label

export function ToolsPage() {
  const rules = useTools((s) => s.rules)
  const loadError = useTools((s) => s.loadError)
  const working = useTools((s) => s.working)
  const failed = useTools((s) => s.failed)

  // Reload on every visit: Claude Code and `/permissions` edit the same file.
  useEffect(() => {
    void useTools.getState().load()
  }, [])

  if (!rules) {
    return (
      <Page title="Tools" summary="Choose which shell, file and git tools the agent may use.">
        {loadError ? (
          <Empty
            tone="error"
            title="Couldn't read ~/.claude/settings.json"
            body={loadError}
            action={{ label: "Retry", run: () => void useTools.getState().load() }}
          />
        ) : (
          <LoadingRows rows={6} label="Loading tool permissions" />
        )}
      </Page>
    )
  }

  const states = TOOLS.map((t) => toolState(t, rules).effective)
  const tally = (b: RuleBehavior) => states.filter((s) => s === b).length
  const others = otherRules(rules)

  return (
    <Page
      title="Tools"
      summary={`${tally("allow")} run without asking, ${tally("ask")} ask first, ${tally("deny")} off. Saved in ~/.claude/settings.json for every chat, so Claude Code follows them too.`}
    >
      {TOOL_GROUPS.map((group) => (
        <section key={group.id} aria-labelledby={`tools-${group.id}`} className="mt-9">
          <h2 id={`tools-${group.id}`} className="text-sm font-semibold">
            {group.title}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{group.description}</p>
          <ul className="mt-3 border-t border-border">
            {group.tools.map((tool) => (
              <ToolRow key={tool.id} tool={tool} />
            ))}
          </ul>
        </section>
      ))}

      <p className="mt-4 text-[13px] text-muted-foreground">
        Accept edits, Auto and Bypass, chosen under the composer, can let a tool set to Ask run without asking. Off
        holds in every mode.
      </p>

      {others.length > 0 && (
        <section aria-labelledby="tools-other" className="mt-9">
          <h2 id="tools-other" className="text-sm font-semibold">
            Other rules in settings.json
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {count(others.length, "rule", "rules")} added with Claude Code or by hand. Remove one to go back to the
            default.
          </p>
          <ul className="mt-3 border-t border-border">
            {others.map(({ rule, behavior }) => (
              <RuleRow
                key={`${behavior}:${rule}`}
                rule={rule}
                meta={label(behavior)}
                removeLabel={`Remove ${rule}`}
                onRemove={() => void useTools.getState().set(`other:${rule}`, [rule], null)}
                busy={!!working[`other:${rule}`]}
                error={failed[`other:${rule}`]}
              />
            ))}
          </ul>
        </section>
      )}

      <FolderRules />
    </Page>
  )
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const rules = useTools((s) => s.rules)!
  const working = useTools((s) => !!s.working[tool.id])
  const failed = useTools((s) => s.failed[tool.id])
  const state = toolState(tool, rules)

  const choose = (choice: RuleBehavior) => {
    if (choice === state.effective && state.own !== "mixed") return
    void useTools.getState().set(tool.id, tool.rules, ruleFor(tool, rules, choice))
  }

  const note = state.lockedBy
    ? `Off because ${state.lockedBy.name} is off`
    : state.overriddenBy
      ? `${state.overriddenBy.name} is set to ${label(state.effective)}, which wins`
      : state.own === "mixed"
        ? "Set per command in settings.json"
        : state.own !== null && state.effective !== state.standard
          ? `Changed from ${label(state.standard)}`
          : null

  return (
    <li className="border-b border-border">
      <div className="flex items-start gap-4 py-3.5">
        <div className={cn("min-w-0 flex-1", state.lockedBy && "opacity-60")}>
          <p className="text-sm font-medium">{tool.name}</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{tool.description}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {note && <span>{note}</span>}
            <code className="selectable font-mono text-[11.5px]">{tool.rules.join(" ")}</code>
          </p>
        </div>
        <ChoiceControl
          name={tool.name}
          value={state.own === "mixed" ? null : state.effective}
          disabled={!!state.lockedBy}
          busy={working}
          onChange={choose}
        />
      </div>
      {failed && <RowError message={`Couldn't save: ${failed}`} />}
    </li>
  )
}

/** Allow, Ask or Off as one joined control; `value` null when no single choice holds. */
function ChoiceControl({
  name,
  value,
  disabled,
  busy,
  onChange,
}: {
  name: string
  value: RuleBehavior | null
  disabled: boolean
  busy: boolean
  onChange: (choice: RuleBehavior) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      aria-busy={busy || undefined}
      className={cn(
        "mt-0.5 flex shrink-0 items-center gap-px rounded-md border border-input p-px",
        (disabled || busy) && "opacity-55",
      )}
    >
      {CHOICES.map((choice) => {
        const checked = value === choice.id
        return (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled || busy}
            onClick={() => onChange(choice.id)}
            className={cn(
              "h-6 rounded-[5px] px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
              checked && "bg-secondary font-medium text-foreground hover:bg-secondary",
              checked && choice.id === "deny" && "text-destructive hover:text-destructive",
            )}
          >
            {choice.label}
          </button>
        )
      })}
    </div>
  )
}

/** The open folder's "Always allow" rules, saved by Elaris rather than settings.json. */
function FolderRules() {
  const root = useWorkspace((s) => s.info?.root)
  const [rules, setRules] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!root) return
    setRules(null)
    setError(null)
    ipc.permissions.list(root).then(setRules, (e) => setError(errorMessage(e)))
  }, [root])

  if (!root) return null
  const folder = root.split("/").filter(Boolean).pop() ?? root

  const forget = async (rule: string) => {
    try {
      setRules(await ipc.permissions.forget(root, rule))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section aria-labelledby="tools-folder" className="mt-9">
      <h2 id="tools-folder" className="text-sm font-semibold">
        Always allowed in {folder}
      </h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        Saved when you choose Always allow in a chat, and used only in this folder. A tool that is off above stays off.
      </p>
      {error && <p role="alert" className="mt-2 text-[13px] text-destructive">{error}</p>}
      {rules === null ? (
        !error && <LoadingRows rows={2} label="Loading this folder's rules" />
      ) : rules.length > 0 ? (
        <ul className="mt-3 border-t border-border">
          {rules.map((rule) => (
            <RuleRow
              key={rule}
              rule={rule}
              meta="Allow"
              removeLabel={`Stop allowing ${rule}`}
              onRemove={() => void forget(rule)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          Nothing saved yet. Choose Always allow when the agent asks, and the rule shows up here.
        </p>
      )}
    </section>
  )
}

function RuleRow({
  rule,
  meta,
  removeLabel,
  onRemove,
  busy = false,
  error,
}: {
  rule: string
  meta: string
  removeLabel: string
  onRemove: () => void
  busy?: boolean
  error?: string
}) {
  return (
    <li className="border-b border-border">
      <div className="group flex h-11 items-center gap-3">
        <code className="selectable min-w-0 flex-1 truncate font-mono text-[12.5px]" title={rule}>
          {rule}
        </code>
        <span className="text-xs text-muted-foreground">{meta}</span>
        <IconButton label={removeLabel} disabled={busy} onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {error && <RowError message={`Couldn't remove: ${error}`} />}
    </li>
  )
}
