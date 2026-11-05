/**
 * `device-control`: Elaris's own tool for Android emulators and iOS
 * simulators. Like `desktop-control`, it's an in-process MCP server given to
 * each run, and every call goes to the Rust host
 * (`apps/desktop/src-tauri/src/agent_device.rs`, `crates/device-control`).
 *
 * It's built to be cheap in tokens: the screen comes back as a short list of
 * elements, steps run in batches, and logs and app data are filtered on the
 * host before they reach the model.
 */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { DesktopResult } from "./desktop.js"
import type { DeviceRequest } from "./protocol.js"

export const DEVICE_SERVER = "device-control"

export const deviceTool = (name: string) => `mcp__${DEVICE_SERVER}__${name}`

/** Tools that only look; they run without asking. */
export const SAFE_DEVICE_TOOLS = ["devices", "screen", "logs", "app_data"].map(deviceTool)

type Call = (request: DeviceRequest) => Promise<DesktopResult>

const INSTRUCTIONS = `Android emulators and iOS simulators, through Elaris. Use this instead of adb, xcrun simctl or screenshots through Bash.
Read the screen with \`screen\`: a numbered list of what's on it, e.g. \`[7] Button "Continue" @540,1820\`. Work from that list. Ask for \`image: true\` only when the look of the screen matters (layout, colours, something the list doesn't show).
Do things with \`act\`: put every step you can predict in one call (tap, type, scroll, wait, key…), tapping by element number from the last list or by visible text rather than coordinates. It returns the screen afterwards, or says it's unchanged.
Use \`logs\` for the app's own log (filtered by \`grep\`) and \`app_data\` for its files, preferences and SQLite databases. Use \`app\` to launch, restart, install or inspect it.
The device and app you last used are remembered, so leave \`device\` and \`app\` out after the first call. Builds from source (expo run, gradle) belong in a terminal, not here.
Don't type passwords, OTPs or payment details, clear app data or uninstall apps without the user saying so in this chat.`

const device = z.string().optional().describe("Emulator serial, simulator UDID or name. Defaults to the device last used, or the only one running.")
const app = z.string().optional().describe("Android package or iOS bundle id, e.g. com.example.app. Defaults to the app last named on this device.")
const maxElements = z.number().int().min(5).max(500).optional().describe("Most elements to list; defaults to 100.")

const target = {
  element: z.number().int().min(1).optional().describe("Element number from the last list."),
  text: z.string().optional().describe("Visible text or label on the screen now."),
  id: z.string().optional().describe("Element id (Android resource-id / testID, iOS accessibility identifier)."),
  x: z.number().int().optional().describe("Device x (Android pixels, iOS points); prefer element or text."),
  y: z.number().int().optional(),
}
const direction = z.enum(["up", "down", "left", "right"])

const step = z.discriminatedUnion("do", [
  z.object({ do: z.literal("tap"), ...target }),
  z.object({ do: z.literal("longPress"), ...target, ms: z.number().int().optional().describe("Defaults to 800.") }),
  z.object({
    do: z.literal("swipe"),
    direction: direction.optional().describe("The way the finger moves, across the middle of the screen."),
    fromX: z.number().int().optional(),
    fromY: z.number().int().optional(),
    toX: z.number().int().optional(),
    toY: z.number().int().optional(),
    ms: z.number().int().optional(),
  }),
  z.object({
    do: z.literal("scroll"),
    direction: direction.describe("The way the content moves: down shows what's further down."),
    untilText: z.string().optional().describe("Keep scrolling until this text shows."),
    max: z.number().int().min(1).max(30).optional().describe("Most scrolls; 1 by default, 8 with untilText."),
  }),
  z.object({
    do: z.literal("type"),
    text: z.string().describe("Typed into the focused field; tap the field first."),
    submit: z.boolean().optional().describe("Press enter afterwards."),
  }),
  z.object({
    do: z.literal("key"),
    key: z.string().describe("back (Android), home, enter, delete, tab, escape, up/down/left/right, recents, power."),
  }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(0).max(30000) }),
  z.object({
    do: z.literal("waitFor"),
    text: z.string().optional(),
    id: z.string().optional(),
    gone: z.boolean().optional().describe("Wait for it to go away instead."),
    timeoutMs: z.number().int().max(60000).optional().describe("Defaults to 10000."),
  }),
  z.object({ do: z.literal("openUrl"), url: z.string().describe("A deep link or web URL.") }),
])

export function deviceServer(call: Call): McpSdkServerConfigWithInstance {
  const answer = async (request: DeviceRequest) => {
    const { ok, text, image } = await call(request)
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text },
    ]
    if (image) content.push({ type: "image", data: image.data, mimeType: image.mediaType })
    return { content, isError: !ok }
  }
  const readOnly = { annotations: { readOnlyHint: true } }

  return createSdkMcpServer({
    name: DEVICE_SERVER,
    version: "1.0.0",
    instructions: INSTRUCTIONS,
    tools: [
      tool(
        "devices",
        "Lists running Android emulators/devices and iOS simulators, and the ones that can be started.",
        {},
        () => answer({ action: "devices" }),
        readOnly,
      ),
      tool(
        "boot",
        "Starts an Android emulator (by AVD name) or iOS simulator (by name or UDID), waits until it's ready and makes it the current device.",
        { name: z.string() },
        (args) => answer({ action: "boot", ...args }),
      ),
      tool(
        "app",
        "Manages an app: list installed apps, launch, stop, restart, install (path to .apk/.app), uninstall, clear its data (Android), or info (version, debuggable, running pid).",
        {
          action: z.enum(["list", "launch", "stop", "restart", "install", "uninstall", "clear", "info"]),
          app,
          path: z.string().optional().describe("The .apk or .app to install."),
          device,
        },
        ({ action, ...rest }) => answer({ action: "app", op: action, ...rest }),
      ),
      tool(
        "screen",
        "The current screen as a numbered list of elements with their centres, plus the foreground app. Optionally a small screenshot too.",
        { image: z.boolean().optional().describe("Also attach a 400 px wide screenshot."), maxElements, device },
        (args) => answer({ action: "screen", ...args }),
        readOnly,
      ),
      tool(
        "act",
        "Runs steps in order (stopping at the first that fails), then returns the screen. Batch everything you can predict into one call.",
        {
          steps: z.array(step).min(1).max(40),
          observe: z
            .enum(["elements", "image", "none"])
            .optional()
            .describe("What to return afterwards: the element list (default), the list plus a screenshot, or nothing."),
          maxElements,
          device,
        },
        (args) => answer({ action: "act", ...args }),
      ),
      tool(
        "logs",
        "The app's log only (Android logcat for its process, iOS unified log for its executable), filtered, with repeated lines collapsed and the newest last.",
        {
          app,
          grep: z.string().optional().describe("Case-insensitive regex lines must match, e.g. \"clevertap|error\"."),
          since: z.number().int().min(1).optional().describe("Only the last this many seconds. iOS defaults to 300."),
          lines: z.number().int().min(1).max(500).optional().describe("Most lines returned; defaults to 60."),
          level: z.enum(["verbose", "debug", "info", "warn", "error"]).optional().describe("Lowest level shown."),
          device,
        },
        (args) => answer({ action: "logs", ...args }),
        readOnly,
      ),
      tool(
        "app_data",
        "Reads the app's own files: ls a folder, read a file (grep to filter; plists are decoded), or run SQL on a SQLite database (a copy; up to 100 rows). Paths are relative to the app's data folder, e.g. shared_prefs/x.xml or databases/x on Android, Library/Preferences/x.plist on iOS. Android needs a debuggable build.",
        {
          action: z.enum(["ls", "read", "sql"]),
          path: z.string().optional(),
          query: z.string().optional().describe("The SQL, for sql."),
          grep: z.string().optional().describe("Case-insensitive regex lines must match, for read."),
          app,
          device,
        },
        ({ action, ...rest }) => answer({ action: "appData", op: action, ...rest }),
        readOnly,
      ),
    ],
  })
}
