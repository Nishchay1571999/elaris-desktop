import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"

import {
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionRuleValue,
  type PermissionUpdate,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import { clipInput, toolOutput } from "./clip.js"
import {
  type AgentEvent,
  type Answers,
  type Command,
  log,
  type PermissionDecision,
  type Question,
  send,
  type TerminalRequest,
} from "./protocol.js"
import { summarize } from "./summary.js"
import { SAFE_TERMINAL_TOOLS, TERMINAL_SERVER, type TerminalResult, terminalServer, terminalTool } from "./terminal.js"

type RunCommand = Extract<Command, { type: "run" }>

interface Run {
  abort: AbortController
  /** Pending permission prompts by request id. */
  permissions: Map<string, (decision: PermissionDecision) => void>
  /** Pending questions by request id. */
  questions: Map<string, (answers: Answers | null) => void>
  /** Terminal calls waiting on the host, by request id. */
  terminals: Map<string, (result: TerminalResult) => void>
}

const runs = new Map<string, Run>()

export function interrupt(runId: string) {
  runs.get(runId)?.abort.abort()
}

export function answerPermission(runId: string, requestId: string, decision: PermissionDecision) {
  runs.get(runId)?.permissions.get(requestId)?.(decision)
}

export function answerQuestion(runId: string, requestId: string, answers: Answers | null) {
  runs.get(runId)?.questions.get(requestId)?.(answers)
}

export function answerTerminal(runId: string, requestId: string, result: TerminalResult) {
  runs.get(runId)?.terminals.get(requestId)?.(result)
}

export function interruptAll() {
  for (const run of runs.values()) run.abort.abort()
}

/** Runs one prompt to completion, translating SDK messages into `AgentEvent`s. */
export async function start(command: RunCommand) {
  const { runId } = command
  // Tools report resolved paths (/private/var vs /var on macOS).
  const cwd = resolveDir(command.cwd)
  const run: Run = { abort: new AbortController(), permissions: new Map(), questions: new Map(), terminals: new Map() }
  runs.set(runId, run)

  const emit = (event: AgentEvent) => send({ type: "event", runId, event })
  const translator = new Translator(emit, cwd)

  // Holds an image prompt's input open until the result, so the agent can
  // still ask for permissions; closing it then lets the run end.
  let closeInput = () => {}
  const inputDone = new Promise<void>((resolve) => (closeInput = resolve))

  try {
    const messages = query({ prompt: await prompt(command, inputDone), options: options(command, run, emit) })
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
    for (const resolve of run.terminals.values()) resolve({ ok: false, text: "The run ended." })
    runs.delete(runId)
    send({ type: "done", runId })
  }
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/** The prompt text, or a user message carrying it and its images, kept open until `done`. */
async function prompt(
  { prompt: text, images = [] }: RunCommand,
  done: Promise<void>,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (images.length === 0) return text
  const blocks = await Promise.all(
    images.map(async ({ mediaType, path }) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: mediaType as ImageMediaType, data: (await readFile(path)).toString("base64") },
    })),
  )
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: text.trim() ? [...blocks, { type: "text", text }] : blocks },
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
            if (decision === "always" && always) {
              send({ type: "rules", runId: command.runId, rules: always.map(formatRule) })
              resolve({
                behavior: "allow",
                updatedInput: input,
                // Stop asking for the rest of this run; later runs get the
                // saved rules through `allowedTools`.
                updatedPermissions: [{ type: "addRules", rules: always, behavior: "allow", destination: "session" }],
              })
              return
            }
            resolve({ behavior: "allow", updatedInput: input })
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
    allowedTools: [...command.allowedTools, ...SAFE_TERMINAL_TOOLS],
    mcpServers: { [TERMINAL_SERVER]: terminalServer((request) => callHost(command.runId, run, request)) },
    disallowedTools: disallowed,
    stderr: (data) => log(data),
    canUseTool,
  }
}

/** Hands a `terminal-access` call to the host and waits for its answer. */
function callHost(runId: string, run: Run, request: TerminalRequest): Promise<TerminalResult> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    run.terminals.set(requestId, (result) => {
      run.terminals.delete(requestId)
      resolve(result)
    })
    send({ type: "terminal", runId, requestId, request })
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

function permissionMode({ mode, permissions }: RunCommand): PermissionMode {
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
 * Turns the SDK's message stream into the transcript's events. Only the main
 * agent's output is shown; subagent activity appears as its Task tool call.
 */
class Translator {
  sessionSent = false
  ended = false
  private wroteText = false
  private needsBreak = false
  /** Output tokens reported so far for the model call in progress, by agent (main or subagent). */
  private outputSeen = new Map<string, number>()

  constructor(
    private emit: (event: AgentEvent) => void,
    private cwd: string,
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
      this.outputSeen.set(key, u.output_tokens)
      this.emit({
        type: "usage",
        usage: { input: u.input_tokens + cacheRead + cacheWrite, output: u.output_tokens, cacheRead, cacheWrite },
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
      case "assistant": {
        if (message.parent_tool_use_id) return
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>
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
        if (message.parent_tool_use_id || typeof message.message.content === "string") return
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            this.emit({ type: "tool-end", id: block.tool_use_id, ok: !block.is_error, output: toolOutput(block.content) })
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
}
