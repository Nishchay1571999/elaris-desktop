/**
 * The plugins Elaris can install. Static until there is a registry to fetch
 * from; each plugin lists what it adds under the same kinds the sidebar's
 * Customizations use.
 */

export type PluginPartKind = "skills" | "agents" | "mcp" | "hooks"

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  parts: Partial<Record<PluginPartKind, string[]>>
}

export const PART_KINDS: Array<{ kind: PluginPartKind; one: string; many: string }> = [
  { kind: "skills", one: "skill", many: "skills" },
  { kind: "agents", one: "agent", many: "agents" },
  { kind: "mcp", one: "MCP server", many: "MCP servers" },
  { kind: "hooks", one: "hook", many: "hooks" },
]

export const PLUGIN_CATALOG: Plugin[] = [
  {
    id: "github",
    name: "GitHub",
    version: "1.4.0",
    description: "Open pull requests, review diffs and triage issues without leaving the chat.",
    parts: {
      skills: ["review-pr", "triage-issues", "write-pr-description"],
      agents: ["pr-reviewer"],
      mcp: ["github"],
    },
  },
  {
    id: "rust-toolkit",
    name: "Rust toolkit",
    version: "0.9.2",
    description: "Cargo workflows, Clippy fixes and a check after every edit to a .rs file.",
    parts: {
      skills: ["cargo-workflows", "fix-clippy"],
      hooks: ["cargo check after edit"],
    },
  },
  {
    id: "commit-hygiene",
    name: "Commit hygiene",
    version: "1.1.0",
    description: "Conventional commit messages, and lint and format before anything is committed.",
    parts: {
      skills: ["commit-messages"],
      hooks: ["lint before commit", "format before commit"],
    },
  },
  {
    id: "test-driven",
    name: "Test-driven development",
    version: "2.0.1",
    description: "Write the failing test first, then the code, and rerun the suite after each change.",
    parts: {
      skills: ["tdd", "write-integration-tests"],
      hooks: ["run tests after edit"],
    },
  },
  {
    id: "security-review",
    name: "Security review",
    version: "1.2.3",
    description: "Audit pending changes for injection, secrets and unsafe dependencies before you merge.",
    parts: {
      skills: ["security-review"],
      agents: ["security-auditor"],
    },
  },
  {
    id: "frontend-design",
    name: "Frontend design",
    version: "1.0.4",
    description: "Art direction for interfaces: type, colour and layout decisions instead of template defaults.",
    parts: {
      skills: ["frontend-design", "design-review"],
    },
  },
  {
    id: "postgres",
    name: "Postgres",
    version: "0.6.0",
    description: "Query a database read-only, inspect its schema and draft reversible migrations.",
    parts: {
      skills: ["sql-migrations"],
      mcp: ["postgres"],
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    version: "1.3.0",
    description: "Pull an error's stack trace and recent events, then trace it to the commit that caused it.",
    parts: {
      skills: ["triage-errors"],
      mcp: ["sentry"],
    },
  },
  {
    id: "figma",
    name: "Figma",
    version: "0.8.1",
    description: "Read frames and variables from a Figma file and build them with your components.",
    parts: {
      skills: ["design-to-code"],
      mcp: ["figma"],
    },
  },
  {
    id: "docs-writer",
    name: "Docs writer",
    version: "1.0.0",
    description: "Keep READMEs, ADRs and API references in step with the code they describe.",
    parts: {
      skills: ["documentation", "write-adr"],
      agents: ["docs-writer"],
    },
  },
]
