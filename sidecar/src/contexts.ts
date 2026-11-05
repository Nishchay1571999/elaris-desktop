/**
 * `elaris-context`: Elaris's own tool for reading saved contexts, whole
 * earlier agent sessions the user saved and handed this chat as `#ctx-…`.
 * Small ones arrive inside the prompt; larger ones are read here, page by
 * page, so nothing is ever trimmed. Every call goes to the Rust host
 * (`apps/desktop/src-tauri/src/agent_contexts.rs`), which keeps them in SQLite.
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { ContextsRequest } from "./protocol.js"

export const CONTEXTS_SERVER = "elaris-context"

const contextsTool = (name: string) => `mcp__${CONTEXTS_SERVER}__${name}`

/** Every tool here only reads what the user saved, so none needs asking. */
export const SAFE_CONTEXT_TOOLS = ["list", "overview", "read", "search", "raw", "terminals"].map(contextsTool)

export interface ContextsResult {
  ok: boolean
  text: string
}

type Call = (request: ContextsRequest) => Promise<ContextsResult>

const INSTRUCTIONS = `Saved contexts: earlier agent sessions the user saved in Elaris, with every prompt, reply, thinking block, tool call, shell command and tool output exactly as it happened, plus the output of terminals the session opened. The user refers to one as #ctx-xxxxxx.
When a prompt includes a <saved-context attached="by-reference"> block, the context was too large to include: start with \`overview\`, then \`read\` it page by page from fromSeq=0 (each page says where the next starts), or \`search\` for the parts you need and \`read\` around them. Read everything relevant before acting on it.`

export function contextsServer(call: Call): McpSdkServerConfigWithInstance {
  const answer = async (request: ContextsRequest) => {
    const { ok, text } = await call(request)
    return { content: [{ type: "text" as const, text }], isError: !ok }
  }
  const id = z.string().describe("The saved context's id, e.g. ctx-7f3k2q (with or without #).")
  const readOnly = { annotations: { readOnlyHint: true } }

  return createSdkMcpServer({
    name: CONTEXTS_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [
      tool(
        "list",
        "The saved contexts, newest first, with their size in tokens.",
        { query: z.string().optional().describe("Only those whose id or title contains this.") },
        (args) => answer({ action: "list", ...args }),
        readOnly,
      ),
      tool(
        "overview",
        "A saved context's size, the user's prompts in order (with the entry each starts at), and how often each tool was used.",
        { id },
        (args) => answer({ action: "overview", ...args }),
        readOnly,
      ),
      tool(
        "read",
        "A page of a saved context in order, as Markdown: prompts, replies, thinking, tool calls with their full input, and full tool results. Ends by saying where the next page starts.",
        {
          id,
          fromSeq: z.number().int().min(0).optional().describe("The entry to start at (default 0)."),
          offset: z.number().int().min(0).optional().describe("Characters into that entry to start at, when a page said so."),
          maxChars: z.number().int().min(1000).max(100_000).optional().describe("Page size in characters (default 40000)."),
        },
        (args) => answer({ action: "read", ...args }),
        readOnly,
      ),
      tool(
        "search",
        "Entries containing some text (any substring, such as part of a command), with the entry number to `read` from.",
        {
          query: z.string().describe("Text to find; case-insensitive."),
          id: id.optional().describe("Only search this saved context; omit to search all of them."),
          limit: z.number().int().min(1).max(100).optional(),
        },
        (args) => answer({ action: "search", ...args }),
        readOnly,
      ),
      tool(
        "raw",
        "One entry exactly as the agent's transcript recorded it, as JSON, e.g. to see image data or fields the Markdown leaves out.",
        { id, seq: z.number().int().min(0).describe("The entry number.") },
        (args) => answer({ action: "raw", ...args }),
        readOnly,
      ),
      tool(
        "terminals",
        "Everything the session's terminal tabs still showed when it was saved: dev servers, logcat, builds.",
        { id },
        (args) => answer({ action: "terminals", ...args }),
        readOnly,
      ),
    ],
  })
}
