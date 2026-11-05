/**
 * `desktop-control`: Elaris's own tool for using the user's Mac like they
 * would: screenshots of the main display, the mouse and the keyboard. Like
 * `terminal-access`, it's an in-process MCP server given to each run, and every
 * call goes to the Rust host (`apps/desktop/src-tauri/src/agent_desktop.rs`).
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { DesktopRequest } from "./protocol.js"

export const DESKTOP_SERVER = "desktop-control"

export interface DesktopResult {
  ok: boolean
  text: string
  /** A screenshot, base64-encoded. */
  image?: { mediaType: string; data: string } | null
}

type Call = (request: DesktopRequest) => Promise<DesktopResult>

const INSTRUCTIONS = `The user's Mac desktop, through Elaris. Take a \`screenshot\` to see the main display, then act with \`click\`, \`type\`, \`key\`, \`scroll\`, \`drag\` and \`move\`; \`open\` launches an app or URL. The user watches it happen.
Coordinates are pixels in the most recent screenshot. Take a fresh screenshot before acting on a screen you haven't seen, and after acting to check what happened; never guess where something is.
Prefer \`key\` shortcuts (e.g. "cmd+l" for a browser's address bar) over hunting for small targets. Use \`open\` rather than clicking through the Dock or Finder.
Don't type passwords or payment details, send messages, buy anything or delete data without the user saying so in this chat. Use other tools (files, shell, terminals) for anything that doesn't need the screen.`

export function desktopServer(call: Call): McpSdkServerConfigWithInstance {
  const answer = async (request: DesktopRequest) => {
    const { ok, text, image } = await call(request)
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text },
    ]
    if (image) content.push({ type: "image", data: image.data, mimeType: image.mediaType })
    return { content, isError: !ok }
  }
  const x = z.number().int().describe("Pixels from the screenshot's left edge.")
  const y = z.number().int().describe("Pixels from the screenshot's top edge.")

  return createSdkMcpServer({
    name: DESKTOP_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [
      tool(
        "screenshot",
        "Captures the main display, scaled to fit 1280×800, and where the pointer is. Other actions take coordinates in its pixels.",
        {},
        () => answer({ action: "screenshot" }),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "click",
        "Clicks at a point in the screenshot.",
        {
          x,
          y,
          button: z.enum(["left", "right", "middle"]).optional().describe("Defaults to left."),
          count: z.number().int().min(1).max(3).optional().describe("2 to double-click, 3 to triple-click (select a line)."),
        },
        (args) => answer({ action: "click", ...args }),
      ),
      tool("move", "Moves the pointer without clicking, e.g. to show a tooltip or open a hover menu.", { x, y }, (args) =>
        answer({ action: "move", ...args }),
      ),
      tool(
        "drag",
        "Presses the left button at one point, drags to another and lets go: moving windows, sliders, selecting text.",
        { fromX: x, fromY: y, toX: x, toY: y },
        (args) => answer({ action: "drag", ...args }),
      ),
      tool(
        "scroll",
        "Scrolls whatever is under a point.",
        {
          x,
          y,
          direction: z.enum(["up", "down", "left", "right"]),
          amount: z.number().int().min(1).max(100).optional().describe("Lines to scroll; defaults to 5."),
        },
        (args) => answer({ action: "scroll", ...args }),
      ),
      tool(
        "type",
        "Types text into whatever has keyboard focus; click the field first. Newlines press Return.",
        { text: z.string() },
        (args) => answer({ action: "type", ...args }),
      ),
      tool(
        "key",
        "Presses a key or shortcut: modifiers (cmd, shift, ctrl, option, fn) and one key joined by +, e.g. \"return\", \"escape\", \"cmd+c\", \"cmd+shift+t\", \"down\".",
        { keys: z.string() },
        (args) => answer({ action: "key", ...args }),
      ),
      tool(
        "open",
        "Opens an app by name (\"Safari\", \"System Settings\") or a URL in its default app, bringing it to the front.",
        { target: z.string() },
        (args) => answer({ action: "open", ...args }),
      ),
    ],
  })
}
