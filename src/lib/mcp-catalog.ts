/**
 * MCP servers Elaris offers to install. Static and hand-picked: the public
 * registry is mostly proxies that need a third-party key, so this lists
 * servers from the services themselves. Installing writes `config()` to the
 * user scope of `~/.claude.json` under the entry's `id`.
 */

export interface McpField {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
}

export type McpAuth =
  | { kind: "none" }
  /** Signs in with an account on the service the first time it connects. */
  | { kind: "oauth"; account: string }
  /** Needs `fields` filled in before installing. */
  | { kind: "key"; fields: McpField[] }

export interface McpCatalogEntry {
  /** Server name in the config, and what tools are prefixed with. */
  id: string
  name: string
  description: string
  auth: McpAuth
  /** The `mcpServers` entry, given the values of `auth.fields`. */
  config: (values: Record<string, string>) => Record<string, unknown>
}

const remote = (url: string) => () => ({ type: "http", url })
const npx = (pkg: string, env?: (values: Record<string, string>) => Record<string, string>) => (values: Record<string, string>) => ({
  type: "stdio",
  command: "npx",
  args: ["-y", pkg],
  ...(env ? { env: env(values) } : {}),
})

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "context7",
    name: "Context7",
    description: "Current docs and code examples for the libraries in your project, fetched when the agent needs them.",
    auth: { kind: "none" },
    config: remote("https://mcp.context7.com/mcp"),
  },
  {
    id: "github",
    name: "GitHub",
    description: "Read and open issues and pull requests, search code and check Actions runs across your repositories.",
    auth: {
      kind: "key",
      fields: [{ key: "token", label: "Personal access token", placeholder: "github_pat_…", secret: true }],
    },
    config: ({ token }) => ({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${token}` },
    }),
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update issues, projects and comments in your Linear workspace.",
    auth: { kind: "oauth", account: "Linear" },
    config: remote("https://mcp.linear.app/mcp"),
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search your workspace, read pages and databases, and write new pages.",
    auth: { kind: "oauth", account: "Notion" },
    config: remote("https://mcp.notion.com/mcp"),
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Look up an issue's stack trace and recent events, and search errors across projects.",
    auth: { kind: "oauth", account: "Sentry" },
    config: remote("https://mcp.sentry.dev/mcp"),
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read frames, components and variables from a Figma file to build them in code.",
    auth: { kind: "oauth", account: "Figma" },
    config: remote("https://mcp.figma.com/mcp"),
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Check deployments, read build and runtime logs, and look up projects and domains.",
    auth: { kind: "oauth", account: "Vercel" },
    config: remote("https://mcp.vercel.com"),
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Query tables, inspect the schema and apply migrations in your Supabase projects.",
    auth: { kind: "oauth", account: "Supabase" },
    config: remote("https://mcp.supabase.com/mcp"),
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Look up customers, payments and subscriptions, and search Stripe's documentation.",
    auth: { kind: "oauth", account: "Stripe" },
    config: remote("https://mcp.stripe.com"),
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Drive a real browser: open pages, click, fill forms and read what is on screen.",
    auth: { kind: "none" },
    config: npx("@playwright/mcp@latest"),
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description: "Inspect a running Chrome: console, network requests, performance traces and the DOM.",
    auth: { kind: "none" },
    config: npx("chrome-devtools-mcp@latest"),
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Search the web and news through Brave's independent index.",
    auth: {
      kind: "key",
      fields: [{ key: "apiKey", label: "Brave Search API key", placeholder: "BSA…", secret: true }],
    },
    config: npx("@brave/brave-search-mcp-server", ({ apiKey }) => ({ BRAVE_API_KEY: apiKey })),
  },
  {
    id: "memory",
    name: "Memory",
    description: "A knowledge graph the agent keeps between chats: people, projects and how they relate.",
    auth: { kind: "none" },
    config: npx("@modelcontextprotocol/server-memory"),
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    description: "Lets the agent work a hard problem in revisable steps before it answers.",
    auth: { kind: "none" },
    config: npx("@modelcontextprotocol/server-sequential-thinking"),
  },
]
