/**
 * `terminal-access`: Elaris's own tool for running commands in terminals the
 * user can see. It exists only inside the editor, as an in-process MCP server
 * given to each run. Every call goes to the Rust host, which starts the
 * terminal (opening it as a tab beside the chat) and answers with its output.
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { TerminalRequest } from "./protocol.js"

export const TERMINAL_SERVER = "terminal-access"

/** The full tool name the agent (and permission rules) use. */
export const terminalTool = (name: "run" | "read" | "write" | "stop" | "list") => `mcp__${TERMINAL_SERVER}__${name}`

/** Calls that only look at or end the agent's own terminals, so they never need asking. */
export const SAFE_TERMINAL_TOOLS = [terminalTool("read"), terminalTool("list"), terminalTool("stop")]

export interface TerminalResult {
  ok: boolean
  text: string
}

type Call = (request: TerminalRequest) => Promise<TerminalResult>

const INSTRUCTIONS = `Terminals in the Elaris editor. Each \`run\` starts a new terminal that opens as a tab beside the chat, where the user watches it live and can type into it.
Use \`run\` with \`background: true\` for anything that keeps running: dev servers, watchers, \`docker compose up\`, tailing logs. It returns once the output settles and the process keeps going; check on it later with \`read\` and end it with \`stop\`. Never background a command with \`&\` or \`nohup\` instead.
Use \`run\` without \`background\` for commands the user may want to watch (builds, test suites, installs). Plain Bash is still fine for quick, quiet commands.
Use \`write\` to answer prompts or send keys, e.g. "y\\n", or "\\u0003" for Ctrl+C.`

export function terminalServer(call: Call): McpSdkServerConfigWithInstance {
  const answer = async (request: TerminalRequest) => {
    const { ok, text } = await call(request)
    return { content: [{ type: "text" as const, text }], isError: !ok }
  }
  const terminalId = z.number().int().describe("The terminal's number, from `run` or `list`.")

  return createSdkMcpServer({
    name: TERMINAL_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [
      tool(
        "run",
        "Runs a shell command in a new terminal tab in the open folder, with the user's full shell environment. Returns the terminal's number, its status and its output.",
        {
          command: z.string().describe("The command line to run."),
          background: z
            .boolean()
            .optional()
            .describe("True for long-running processes (dev servers, watchers): return once output settles and leave it running."),
          title: z.string().optional().describe("A short tab title, e.g. 'Dev server'. Defaults to the command."),
          waitSeconds: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("How long to wait: for the command to finish (default 120, max 600), or in the background for output to settle (default 10, max 60)."),
        },
        (args) => answer({ action: "run", ...args }),
      ),
      tool(
        "read",
        "Output a terminal has printed since you last read it, and whether its process is still running.",
        {
          terminalId,
          waitSeconds: z.number().int().min(0).optional().describe("Wait up to this long (max 60) for new output if there is none yet."),
        },
        (args) => answer({ action: "read", ...args }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "write",
        "Types text into a terminal, as if the user typed it: answers to prompts, or keys such as \\u0003 (Ctrl+C). Include \\n to press Enter.",
        { terminalId, input: z.string() },
        (args) => answer({ action: "write", ...args }),
      ),
      tool(
        "stop",
        "Stops a terminal's process (Ctrl+C, then kill if it doesn't exit) and returns its last output. The tab stays open for the user.",
        { terminalId },
        (args) => answer({ action: "stop", ...args }),
        { annotations: { destructiveHint: false } },
      ),
      tool("list", "The terminals this chat has started, with their status.", {}, () => answer({ action: "list" }), {
        annotations: { readOnlyHint: true },
      }),
    ],
  })
}
