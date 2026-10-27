/**
 * Elaris agent sidecar: runs the Claude Agent SDK on behalf of the Rust host,
 * which starts this process and talks to it over stdio (see protocol.ts).
 * Several runs (one per chat) can be in flight at once.
 */
import { delimiter, dirname } from "node:path"
import { createInterface } from "node:readline"

import { type Command, log, send } from "./protocol.js"
import { answerPermission, answerQuestion, answerTerminal, interrupt, interruptAll, start } from "./run.js"
import { sessionUsage } from "./usage.js"

// MCP servers started with `npx …` need node on PATH, which an app opened
// from Finder doesn't have; the node running this script is the one to use.
process.env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter)

const lines = createInterface({ input: process.stdin })

lines.on("line", (line) => {
  if (!line.trim()) return
  let command: Command
  try {
    command = JSON.parse(line) as Command
  } catch {
    log(`ignoring malformed command: ${line.slice(0, 200)}`)
    return
  }
  switch (command.type) {
    case "run":
      void start(command)
      break
    case "interrupt":
      interrupt(command.runId)
      break
    case "permission":
      answerPermission(command.runId, command.requestId, command.decision)
      break
    case "answer":
      answerQuestion(command.runId, command.requestId, command.answers)
      break
    case "terminalResult":
      answerTerminal(command.runId, command.requestId, { ok: command.ok, text: command.text })
      break
    case "usage": {
      const { runId, agentSessionId } = command
      sessionUsage(agentSessionId)
        .catch((error: unknown) => {
          log(`reading usage for ${agentSessionId}: ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        .then((usage) => send({ type: "usage", runId, usage }))
      break
    }
  }
})

// The host closed our stdin: it quit or restarted us.
lines.on("close", () => {
  interruptAll()
  setTimeout(() => process.exit(0), 500).unref()
})
