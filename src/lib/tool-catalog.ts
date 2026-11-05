/**
 * The agent's shell, file, git and desktop tools as the Tools page shows them, and how
 * each maps onto Claude Code's permission rules in `~/.claude/settings.json`.
 *
 * Git has no tools of its own: the agent runs `git` through Bash, so each git
 * entry is a set of `Bash(git …:*)` rules, and turning Bash off turns them off.
 */
import type { PermissionRules } from "@/bindings/PermissionRules"
import type { RuleBehavior } from "@/bindings/RuleBehavior"

export interface ToolEntry {
  id: string
  name: string
  description: string
  /** The rules a choice writes, all to the same list. */
  rules: string[]
  /** What the agent does with no rule set, in the default permission mode. */
  fallback: "allow" | "ask"
  /** An entry whose rules are narrower patterns of this one's (git and rm under Bash). */
  parent?: string
}

export interface ToolGroup {
  id: string
  title: string
  description: string
  tools: ToolEntry[]
}

const BASH = "bash"
const bash = (...commands: string[]) => commands.map((c) => `Bash(${c}:*)`)
const desktop = (...actions: string[]) => actions.map((a) => `mcp__desktop-control__${a}`)
const device = (...tools: string[]) => tools.map((t) => `mcp__device-control__${t}`)

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "shell",
    title: "Shell",
    description: "Commands the agent runs in the open folder, such as tests, builds and installs.",
    tools: [
      {
        id: BASH,
        name: "Run commands",
        description: "Any shell command. Turning this off also turns off every git command below.",
        rules: ["Bash"],
        fallback: "ask",
      },
      {
        id: "terminal-run",
        name: "Run in terminal tabs",
        description: "Commands the agent runs in a terminal tab beside the chat, such as dev servers. Elaris only.",
        rules: ["mcp__terminal-access__run"],
        fallback: "ask",
      },
      {
        id: "terminal-write",
        name: "Type into terminal tabs",
        description: "Answering prompts in, or sending keys to, terminals the agent started.",
        rules: ["mcp__terminal-access__write"],
        fallback: "ask",
      },
      {
        id: "rm",
        name: "Delete with rm",
        description: "Removing files and folders from the command line.",
        rules: bash("rm"),
        fallback: "ask",
        parent: BASH,
      },
    ],
  },
  {
    id: "files",
    title: "Files",
    description: "Reading and changing files directly, without going through the shell.",
    tools: [
      { id: "read", name: "Read files", description: "Open any file to see what it holds.", rules: ["Read"], fallback: "allow" },
      { id: "glob", name: "Find files", description: "List files whose paths match a pattern.", rules: ["Glob"], fallback: "allow" },
      { id: "grep", name: "Search contents", description: "Search text across the folder.", rules: ["Grep"], fallback: "allow" },
      { id: "edit", name: "Edit files", description: "Change part of an existing file.", rules: ["Edit"], fallback: "ask" },
      { id: "write", name: "Create and overwrite files", description: "Write a whole file, new or existing.", rules: ["Write"], fallback: "ask" },
      { id: "notebook", name: "Edit notebooks", description: "Change cells in Jupyter notebooks.", rules: ["NotebookEdit"], fallback: "ask" },
    ],
  },
  {
    id: "git",
    title: "Git",
    description: "Git commands the agent runs through the shell, from looking at history to pushing it.",
    tools: [
      {
        id: "git-read",
        name: "Look at changes and history",
        description: "git status, diff, log and show.",
        rules: bash("git status", "git diff", "git log", "git show"),
        fallback: "allow",
        parent: BASH,
      },
      {
        id: "git-commit",
        name: "Stage and commit",
        description: "git add and git commit.",
        rules: bash("git add", "git commit"),
        fallback: "ask",
        parent: BASH,
      },
      {
        id: "git-branch",
        name: "Switch and create branches",
        description: "git switch, checkout and branch.",
        rules: bash("git switch", "git checkout", "git branch"),
        fallback: "ask",
        parent: BASH,
      },
      {
        id: "git-push",
        name: "Push",
        description: "Send commits to a remote with git push.",
        rules: bash("git push"),
        fallback: "ask",
        parent: BASH,
      },
      {
        id: "git-rewrite",
        name: "Rewrite or discard work",
        description: "git reset, rebase, restore and clean, which can lose changes.",
        rules: bash("git reset", "git rebase", "git restore", "git clean"),
        fallback: "ask",
        parent: BASH,
      },
    ],
  },
  {
    id: "desktop",
    title: "Desktop",
    description: "Using your Mac's screen, mouse and keyboard as you would. Elaris only, macOS only.",
    tools: [
      {
        id: "desktop-screenshot",
        name: "See the screen",
        description: "Take screenshots of the main display. macOS asks for Screen Recording the first time.",
        rules: desktop("screenshot"),
        fallback: "ask",
      },
      {
        id: "desktop-input",
        name: "Use the mouse and keyboard",
        description: "Click, drag, scroll, type and press shortcuts. macOS asks for Accessibility the first time.",
        rules: desktop("click", "move", "drag", "scroll", "type", "key"),
        fallback: "ask",
      },
      {
        id: "desktop-open",
        name: "Open apps and links",
        description: "Launch an app or open a URL, bringing it to the front.",
        rules: desktop("open"),
        fallback: "ask",
      },
    ],
  },
  {
    id: "devices",
    title: "Devices",
    description: "Android emulators and iOS simulators: reading the screen as text, tapping and typing, app logs and data. Elaris only; iOS needs AXe (brew install cameroncooke/axe/axe).",
    tools: [
      {
        id: "device-read",
        name: "Read devices and apps",
        description: "List devices, read the screen, read an app's logs, files and databases. Changes nothing.",
        rules: device("devices", "screen", "logs", "app_data"),
        fallback: "allow",
      },
      {
        id: "device-act",
        name: "Tap, type and swipe",
        description: "Use the app on the device as a person would, in batches of steps.",
        rules: device("act"),
        fallback: "ask",
      },
      {
        id: "device-manage",
        name: "Start devices and manage apps",
        description: "Boot an emulator or simulator; launch, stop, install, uninstall or clear an app.",
        rules: device("boot", "app"),
        fallback: "ask",
      },
    ],
  },
]

export const TOOLS = TOOL_GROUPS.flatMap((g) => g.tools)
const byId = new Map(TOOLS.map((t) => [t.id, t]))

/** Every rule the page manages; the rest of settings.json is shown as other rules. */
export const MANAGED_RULES = new Set(TOOLS.flatMap((t) => t.rules))

/** The list a rule sits in; deny wins over ask and ask over allow, as in Claude Code. */
function behaviorOf(rules: PermissionRules, rule: string): RuleBehavior | null {
  if (rules.deny.includes(rule)) return "deny"
  if (rules.ask.includes(rule)) return "ask"
  if (rules.allow.includes(rule)) return "allow"
  return null
}

function strongest(behaviors: Array<RuleBehavior | null>): RuleBehavior | null {
  for (const b of ["deny", "ask", "allow"] as const) if (behaviors.includes(b)) return b
  return null
}

export interface ToolState {
  /** What the agent does now. */
  effective: RuleBehavior
  /** What it would do with this entry's own rules cleared. */
  standard: RuleBehavior
  /** What this entry's own rules say; `null` when none are set, "mixed" when they disagree. */
  own: RuleBehavior | null | "mixed"
  /** Off because its parent is off; the choice can't change anything. */
  lockedBy: ToolEntry | null
  /** Its own rule is overridden by a stricter one on the parent. */
  overriddenBy: ToolEntry | null
}

export function toolState(tool: ToolEntry, rules: PermissionRules): ToolState {
  const mine = tool.rules.map((r) => behaviorOf(rules, r))
  const own = mine.every((b) => b === mine[0]) ? mine[0] : "mixed"
  const parent = tool.parent ? byId.get(tool.parent) : undefined
  const fromParent = parent ? strongest(parent.rules.map((r) => behaviorOf(rules, r))) : null

  const effective = strongest([...mine, fromParent]) ?? tool.fallback
  const ownStrongest = strongest(mine)
  return {
    effective,
    standard: fromParent ?? tool.fallback,
    own,
    lockedBy: parent && fromParent === "deny" ? parent : null,
    overriddenBy: parent && ownStrongest && fromParent && effective !== ownStrongest ? parent : null,
  }
}

/**
 * The list to write `choice` to, or `null` to clear the entry's rules when the
 * choice is what the agent would do anyway, so settings.json stays short.
 */
export function ruleFor(tool: ToolEntry, rules: PermissionRules, choice: RuleBehavior): RuleBehavior | null {
  return toolState(tool, rules).standard === choice ? null : choice
}

/** Rules in settings.json the page doesn't manage, with their list. */
export function otherRules(rules: PermissionRules): Array<{ rule: string; behavior: RuleBehavior }> {
  return (["allow", "ask", "deny"] as const).flatMap((behavior) =>
    rules[behavior].filter((rule) => !MANAGED_RULES.has(rule)).map((rule) => ({ rule, behavior })),
  )
}
