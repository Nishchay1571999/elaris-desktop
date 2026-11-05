import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionRuleValue,
  type PermissionUpdate,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import { clipInput, toolOutput } from "./clip.js"
import {
  type AgentEvent,
  type AgentMode,
  type Answers,
  type Command,
  type ContextsRequest,
  type DesktopRequest,
  type DeviceRequest,
  log,
  type PermissionDecision,
  type PermissionPolicy,
  type Question,
  send,
  type TerminalRequest,
} from "./protocol.js"
import { CONTEXTS_SERVER, type ContextsResult, contextsServer, SAFE_CONTEXT_TOOLS } from "./contexts.js"
import { DESKTOP_SERVER, type DesktopResult, desktopServer } from "./desktop.js"
import { DEVICE_SERVER, deviceServer, SAFE_DEVICE_TOOLS } from "./device.js"
import { summarize } from "./summary.js"
import { SAFE_TERMINAL_TOOLS, TERMINAL_SERVER, type TerminalResult, terminalServer, terminalTool } from "./terminal.js"

type RunCommand = Extract<Command, { type: "run" }>

interface Run {
  abort: AbortController
  /** The SDK query, once started; settings changed mid-run go through it. */
  query?: Query
  model: string
  policy: PermissionPolicy
  /** The mode the agent is in, which it can change itself. */
  modes: ModeTracker
  /** Pending permission prompts by request id. */
  permissions: Map<string, (decision: PermissionDecision) => void>
  /** Pending questions by request id. */
  questions: Map<string, (answers: Answers | null) => void>
  /** Terminal, desktop, device and context calls waiting on the host, by request id. */
  hostCalls: Map<string, (result: DesktopResult) => void>
}

const runs = new Map<string, Run>()

export function interrupt(runId: string) {
  runs.get(runId)?.abort.abort()
}

/**
 * Switches a running agent to the chat's new settings. Ask's tool restrictions
 * are fixed when a run starts, so Ask only takes effect from the next message.
 */
export function updateSettings({ runId, mode, model, permissions }: Extract<Command, { type: "settings" }>) {
  const run = runs.get(runId)
  if (!run?.query) return
  const failed = (what: string) => (error: unknown) =>
    log(`switching ${what} for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
  if (mode !== run.modes.mode || permissions !== run.policy) {
    run.modes.chose(mode)
    run.policy = permissions
    run.query.setPermissionMode(permissionMode({ mode, permissions })).catch(failed("permission mode"))
  }
  if (model !== run.model) {
    run.model = model
    run.query.setModel(model).catch(failed("model"))
  }
}

export function answerPermission(runId: string, requestId: string, decision: PermissionDecision) {
  runs.get(runId)?.permissions.get(requestId)?.(decision)
}

export function answerQuestion(runId: string, requestId: string, answers: Answers | null) {
  runs.get(runId)?.questions.get(requestId)?.(answers)
}

/** Answers a terminal, desktop, device or context call the host carried out. */
export function answerHost(runId: string, requestId: string, result: DesktopResult) {
  runs.get(runId)?.hostCalls.get(requestId)?.(result)
}

export function interruptAll() {
  for (const run of runs.values()) run.abort.abort()
}

/** Runs one prompt to completion, translating SDK messages into `AgentEvent`s. */
export async function start(command: RunCommand) {
  const { runId } = command
  // Tools report resolved paths (/private/var vs /var on macOS).
  const cwd = resolveDir(command.cwd)
  const emit = (event: AgentEvent) => send({ type: "event", runId, event })
  const run: Run = {
    abort: new AbortController(),
    model: command.model,
    policy: command.permissions,
    modes: new ModeTracker(command.mode, emit),
    permissions: new Map(),
    questions: new Map(),
    hostCalls: new Map(),
  }
  runs.set(runId, run)

  const translator = new Translator(emit, cwd, run.modes)

  // Holds the prompt's input open until the result, so the agent can still
  // ask for permissions and take new settings; closing it lets the run end.
  let closeInput = () => {}
  const inputDone = new Promise<void>((resolve) => (closeInput = resolve))

  try {
    const messages = query({ prompt: await prompt(command, inputDone), options: options(command, run, emit) })
    run.query = messages
    for await (const message of messages) {
      if (!translator.sessionSent && message.session_id) {
        send({ type: "session", runId, agentSessionId: message.session_id })
        translator.sessionSent = true
      }
      translator.handle(message)
      if (message.type === "result") closeInput()
    }
    if (!translator.ended) emit(run.abort.signal.aborted ? { type: "stopped" } : { type: "finish" })
  } catch (error) {
    if (!translator.ended) {
      emit(
        run.abort.signal.aborted
          ? { type: "stopped" }
          : { type: "error", message: error instanceof Error ? error.message : String(error) },
      )
    }
  } finally {
    closeInput()
    for (const resolve of run.permissions.values()) resolve("deny")
    for (const resolve of run.questions.values()) resolve(null)
    for (const resolve of run.hostCalls.values()) resolve({ ok: false, text: "The run ended." })
    runs.delete(runId)
    send({ type: "done", runId })
  }
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/**
 * The prompt as a user message carrying its text and images, kept open until
 * `done`: the SDK only takes mid-run setting changes on an open input.
 */
async function prompt({ prompt: text, images = [] }: RunCommand, done: Promise<void>): Promise<AsyncIterable<SDKUserMessage>> {
  const blocks = await Promise.all(
    images.map(async ({ mediaType, path }) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: mediaType as ImageMediaType, data: (await readFile(path)).toString("base64") },
    })),
  )
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: blocks.length === 0 ? text : text.trim() ? [...blocks, { type: "text", text }] : blocks },
    parent_tool_use_id: null,
  }
  return (async function* () {
    yield message
    await done
  })()
}

function resolveDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** The sidecar's link to the SDK, which each `pnpm install` re-points at the current version. */
const SDK_LINK = fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-agent-sdk", import.meta.url))

/**
 * The SDK's native CLI binary, looked up fresh for each run. The SDK finds it
 * relative to the copy of itself this process loaded, so after a reinstall
 * swaps the versioned pnpm folders, a long-lived sidecar would look in a
 * folder that's gone. Undefined leaves the lookup to the SDK.
 */
function claudeExecutable(): string | undefined {
  const exe = process.platform === "win32" ? "claude.exe" : "claude"
  const platform = `${process.platform}-${process.arch}`
  const packages = process.platform === "linux" ? [platform, `${platform}-musl`] : [platform]
  try {
    const scope = dirname(realpathSync(SDK_LINK))
    return packages.map((name) => join(scope, `claude-agent-sdk-${name}`, exe)).find((path) => existsSync(path))
  } catch {
    return undefined
  }
}

function options(command: RunCommand, run: Run, emit: (event: AgentEvent) => void): Options {
  const disallowed: string[] = []
  if (command.mode === "ask") disallowed.push("Edit", "MultiEdit", "Write", "NotebookEdit")

  const cwd = resolveDir(command.cwd)
  const canUseTool: CanUseTool = (toolName, input, { signal, toolUseID, suggestions }) =>
    toolName === "AskUserQuestion"
      ? askUser(run, emit, toolUseID, input, signal)
      : new Promise<PermissionResult>((resolve) => {
          const requestId = toolUseID
          const always = alwaysRules(toolName, suggestions)
          const settle = (decision: PermissionDecision) => {
            if (!run.permissions.delete(requestId)) return
            emit({ type: "permission-resolved", requestId, allowed: decision !== "deny" })
            if (decision === "deny") {
              resolve({ behavior: "deny", message: "The user declined this action." })
              return
            }
            const updates: PermissionUpdate[] = []
            if (decision === "always" && always) {
              send({ type: "rules", runId: command.runId, rules: always.map(formatRule) })
              // Stop asking for the rest of this run; later runs get the
              // saved rules through `allowedTools`.
              updates.push({ type: "addRules", rules: always, behavior: "allow", destination: "session" })
            }
            if (toolName === "ExitPlanMode") {
              // The plan is approved: build it under the chat's own permission policy.
              const next = run.modes.leavePlan()
              updates.push({
                type: "setMode",
                mode: permissionMode({ mode: next, permissions: run.policy }),
                destination: "session",
              })
            }
            resolve({ behavior: "allow", updatedInput: input, ...(updates.length > 0 && { updatedPermissions: updates }) })
          }
          run.permissions.set(requestId, settle)
          signal.addEventListener("abort", () => settle("deny"), { once: true })
          emit({
            type: "permission-request",
            requestId,
            toolName,
            summary: summarize(toolName, input, cwd),
            input: clipInput(input),
            always: always?.map(formatRule) ?? null,
          })
        })

  return {
    cwd: command.cwd,
    model: command.model,
    resume: command.resume ?? undefined,
    abortController: run.abort,
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: permissionMode(command),
    allowDangerouslySkipPermissions: command.permissions === "bypass",
    allowedTools: [...command.allowedTools, ...SAFE_TERMINAL_TOOLS, ...SAFE_CONTEXT_TOOLS, ...SAFE_DEVICE_TOOLS],
    mcpServers: {
      [TERMINAL_SERVER]: terminalServer((request) => callTerminal(command.runId, run, request)),
      [DESKTOP_SERVER]: desktopServer((request) => callDesktop(command.runId, run, request)),
      [DEVICE_SERVER]: deviceServer((request) => callDevice(command.runId, run, request)),
      [CONTEXTS_SERVER]: contextsServer((request) => callContexts(command.runId, run, request)),
    },
    disallowedTools: disallowed,
    stderr: (data) => log(data),
    canUseTool,
    pathToClaudeCodeExecutable: claudeExecutable(),
  }
}

/** Hands a `terminal-access` call to the host and waits for its answer. */
function callTerminal(runId: string, run: Run, request: TerminalRequest): Promise<TerminalResult> {
  return callHost(run, (requestId) => send({ type: "terminal", runId, requestId, request }))
}

/** Hands a `desktop-control` call to the host and waits for its answer. */
function callDesktop(runId: string, run: Run, request: DesktopRequest): Promise<DesktopResult> {
  return callHost(run, (requestId) => send({ type: "desktop", runId, requestId, request }))
}

/** Hands a `device-control` call to the host and waits for its answer. */
function callDevice(runId: string, run: Run, request: DeviceRequest): Promise<DesktopResult> {
  return callHost(run, (requestId) => send({ type: "device", runId, requestId, request }))
}

/** Hands an `elaris-context` call to the host and waits for its answer. */
function callContexts(runId: string, run: Run, request: ContextsRequest): Promise<ContextsResult> {
  return callHost(run, (requestId) => send({ type: "contexts", runId, requestId, request }))
}

function callHost(run: Run, ask: (requestId: string) => void): Promise<DesktopResult> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    run.hostCalls.set(requestId, (result) => {
      run.hostCalls.delete(requestId)
      resolve(result)
    })
    ask(requestId)
  })
}

/** Terminal tools where any "always allow" rule would allow every command. */
const TERMINAL_COMMANDS = new Set([terminalTool("run"), terminalTool("write")])

/**
 * The rules "always allow" would save: the SDK's own allow-rule suggestions
 * (e.g. `Bash(pnpm test:*)`), or the bare tool name for tools other than Bash,
 * where a blanket rule would allow any command. Never for the terminal tool's
 * commands, which the SDK can't narrow.
 */
function alwaysRules(toolName: string, suggestions: PermissionUpdate[] | undefined): PermissionRuleValue[] | null {
  const suggested = (suggestions ?? []).flatMap((update) =>
    update.type === "addRules" && update.behavior === "allow" ? update.rules : [],
  )
  if (TERMINAL_COMMANDS.has(toolName)) return null
  if (suggested.length > 0) return suggested
  return toolName === "Bash" ? null : [{ toolName }]
}

function formatRule({ toolName, ruleContent }: PermissionRuleValue): string {
  return ruleContent ? `${toolName}(${ruleContent})` : toolName
}

/** Puts the agent's `AskUserQuestion` to the user and hands back their answers. */
function askUser(
  run: Run,
  emit: (event: AgentEvent) => void,
  requestId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    const settle = (answers: Answers | null) => {
      if (!run.questions.delete(requestId)) return
      emit({ type: "question-resolved", requestId })
      resolve(
        answers
          ? { behavior: "allow", updatedInput: { ...input, answers } }
          : { behavior: "deny", message: "The user chose not to answer." },
      )
    }
    run.questions.set(requestId, settle)
    signal.addEventListener("abort", () => settle(null), { once: true })
    emit({ type: "question", requestId, questions: readQuestions(input) })
  })
}

function readQuestions(input: Record<string, unknown>): Question[] {
  const questions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
  return questions.map((q) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => ({
      label: String(o.label ?? ""),
      description: String(o.description ?? ""),
    })),
  }))
}

function permissionMode({ mode, permissions }: Pick<RunCommand, "mode" | "permissions">): PermissionMode {
  if (mode === "plan") return "plan"
  switch (permissions) {
    case "accept-edits":
      return "acceptEdits"
    case "auto":
      return "auto"
    case "bypass":
      return "bypassPermissions"
    default:
      return "default"
  }
}

/**
 * The chat's mode as the agent is really running it. The agent can enter plan
 * mode itself, and leaves it when the user approves the plan; each change is
 * reported so the chat's mode follows.
 */
class ModeTracker {
  /** Where an approved plan leads: the mode the chat was in before planning. */
  private afterPlan: AgentMode

  constructor(
    public mode: AgentMode,
    private emit: (event: AgentEvent) => void,
  ) {
    this.afterPlan = mode === "plan" ? "agent" : mode
  }

  /** The user picked `mode`; the chat already shows it. */
  chose(mode: AgentMode) {
    this.mode = mode
    if (mode !== "plan") this.afterPlan = mode
  }

  enterPlan() {
    this.set("plan")
  }

  /** Leaves plan mode, if in it, and returns the mode the agent is in now. */
  leavePlan(): AgentMode {
    if (this.mode === "plan") this.set(this.afterPlan)
    return this.mode
  }

  /** The SDK reported the permission mode it runs in. */
  reported(mode: PermissionMode) {
    if (mode === "plan") this.enterPlan()
    else this.leavePlan()
  }

  private set(mode: AgentMode) {
    if (mode === this.mode) return
    this.mode = mode
    this.emit({ type: "mode", mode })
  }
}

/**
 * Turns the SDK's message stream into the transcript's events. The main
 * agent's output streams as it's written; each subagent's comes a message at
 * a time, wrapped in `subagent` events for its own tab.
 */
class Translator {
  sessionSent = false
  ended = false
  private wroteText = false
  private needsBreak = false
  /** Subagents seen starting, so other background tasks (shells, monitors) are left out. */
  private subagents = new Set<string>()
  /** Subagents that have written text, so the next text starts a new paragraph. */
  private subagentsWithText = new Set<string>()
  /** Output tokens reported so far for the model call in progress, by agent (main or subagent). */
  private outputSeen = new Map<string, number>()
  /** The main agent's tool calls by id, to tell which tool a result belongs to. */
  private toolNames = new Map<string, string>()

  constructor(
    private emit: (event: AgentEvent) => void,
    private cwd: string,
    private modes: ModeTracker,
  ) {}

  /**
   * Reports each model call's tokens, subagents' included: the prompt when the
   * call starts, then its output as it grows.
   */
  private countTokens(agent: string | null, event: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    const key = agent ?? ""
    if (event.type === "message_start") {
      const u = event.message.usage
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheWrite = u.cache_creation_input_tokens ?? 0
      const input = u.input_tokens + cacheRead + cacheWrite
      this.outputSeen.set(key, u.output_tokens)
      this.emit({
        type: "usage",
        usage: { input, output: u.output_tokens, cacheRead, cacheWrite },
        ...(agent === null && { context: input }),
      })
    } else if (event.type === "message_delta") {
      const output = event.usage.output_tokens
      const added = output - (this.outputSeen.get(key) ?? 0)
      this.outputSeen.set(key, output)
      if (added > 0) this.emit({ type: "usage", usage: { input: 0, output: added, cacheRead: 0, cacheWrite: 0 } })
    }
  }

  handle(message: SDKMessage) {
    switch (message.type) {
      case "stream_event": {
        this.countTokens(message.parent_tool_use_id, message.event)
        if (message.parent_tool_use_id) return
        const { event } = message
        // Separate text from consecutive model turns (around tool calls).
        if (event.type === "content_block_start" && event.content_block.type === "text" && this.wroteText) {
          this.needsBreak = true
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const delta = this.needsBreak ? `\n\n${event.delta.text}` : event.delta.text
          this.needsBreak = false
          this.wroteText = true
          this.emit({ type: "text-delta", delta })
        }
        return
      }
      case "system":
        if ((message.subtype === "init" || message.subtype === "status") && message.permissionMode) {
          this.modes.reported(message.permissionMode)
        }
        this.handleTask(message)
        return
      case "assistant": {
        if (message.agent_id) return this.handleSubagent(message.agent_id, message)
        if (message.parent_tool_use_id) return
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>
            this.toolNames.set(block.id, block.name)
            this.emit({
              type: "tool-start",
              id: block.id,
              name: block.name,
              summary: summarize(block.name, input, this.cwd),
              input: clipInput(input),
            })
          }
        }
        return
      }
      case "user": {
        if ("agent_id" in message && message.agent_id) return this.handleSubagent(message.agent_id, message)
        if (message.parent_tool_use_id || typeof message.message.content === "string") return
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            this.emit({ type: "tool-end", id: block.tool_use_id, ok: !block.is_error, output: toolOutput(block.content) })
            if (!block.is_error) this.trackMode(this.toolNames.get(block.tool_use_id))
          }
        }
        return
      }
      case "result": {
        this.ended = true
        if (message.subtype === "success" && !message.is_error) {
          this.emit({ type: "finish" })
        } else {
          const detail =
            message.subtype === "success" ? message.result : message.errors.join("\n") || message.subtype
          this.emit({ type: "error", message: detail || "The agent stopped with an error" })
        }
        return
      }
    }
  }
  /** The agent's own way in and out of plan mode. */
  private trackMode(toolName: string | undefined) {
    if (toolName === "EnterPlanMode") this.modes.enterPlan()
    else if (toolName === "ExitPlanMode") this.modes.leavePlan()
  }

  /** Starts and ends of subagents, from the SDK's task events. */
  private handleTask(message: Extract<SDKMessage, { type: "system" }>) {
    if (message.subtype === "task_started") {
      const isAgent = message.task_type ? message.task_type === "local_agent" : Boolean(message.subagent_type)
      if (!isAgent) return
      this.subagents.add(message.task_id)
      this.emit({
        type: "subagent-start",
        agent: message.task_id,
        toolId: message.tool_use_id ?? null,
        description: message.description,
      })
    } else if (message.subtype === "task_notification" && this.subagents.has(message.task_id)) {
      this.emit({ type: "subagent-end", agent: message.task_id, status: message.status })
    }
  }

  /** A subagent's whole message: its text and tool calls, or its tool results. */
  private handleSubagent(agent: string, message: Extract<SDKMessage, { type: "assistant" | "user" }>) {
    const emit = (event: AgentEvent) => this.emit({ type: "subagent", agent, event })
    const content = message.message.content
    // A plain string is the prompt it was given, which its tab shows from the Agent call.
    if (typeof content === "string") return
    for (const block of content) {
      if (block.type === "text" && message.type === "assistant" && block.text) {
        const first = !this.subagentsWithText.has(agent)
        this.subagentsWithText.add(agent)
        emit({ type: "text-delta", delta: first ? block.text : `\n\n${block.text}` })
      } else if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>
        emit({
          type: "tool-start",
          id: block.id,
          name: block.name,
          summary: summarize(block.name, input, this.cwd),
          input: clipInput(input),
        })
      } else if (block.type === "tool_result") {
        emit({ type: "tool-end", id: block.tool_use_id, ok: !block.is_error, output: toolOutput(block.content) })
      }
    }
  }
}
