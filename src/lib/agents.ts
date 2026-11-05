import type { Message } from "@/bindings/Message"
import type { Part } from "@/bindings/Part"
import type { SubagentStatus } from "@/bindings/SubagentStatus"

/** Tabs for a chat's subagents are keyed `agent:<id>`, the SDK's id for the agent. */
export const agentTabKey = (id: string) => `agent:${id}`
export const isAgentTab = (key: string) => key.startsWith("agent:")
export const agentOfTab = (key: string) => key.slice("agent:".length)

/** A subagent's whole conversation, joined from every reply that started or resumed it. */
export interface AgentThread {
  id: string
  description: string
  status: SubagentStatus
  /** What it was asked and what the user sent it (`input` parts), its text and tool calls, in order. */
  parts: Part[]
}

/** The chat's subagents in the order they started. */
export function agentThreads(messages: Message[]): AgentThread[] {
  const threads = new Map<string, AgentThread>()
  for (const message of messages) {
    for (const agent of message.agents ?? []) {
      let thread = threads.get(agent.id)
      if (!thread) {
        thread = { id: agent.id, description: "", status: agent.status, parts: [] }
        threads.set(agent.id, thread)
      }
      const prompt = spawnPrompt(message, agent.toolId)
      thread.description ||= agent.description
      thread.status = agent.status
      thread.parts.push(...(prompt ? [{ type: "input" as const, text: prompt }] : []), ...agent.parts)
    }
  }
  return [...threads.values()]
}

export function agentThread(messages: Message[], id: string): AgentThread | undefined {
  return agentThreads(messages).find((t) => t.id === id)
}

/** The prompt of the `Agent` call that spawned a subagent, from the same reply. */
function spawnPrompt(message: Message, toolId: string | null): string | null {
  if (!toolId) return null
  const call = message.parts.find((p) => p.type === "tool" && p.id === toolId)
  if (call?.type !== "tool" || !SPAWN_TOOLS.has(call.name)) return null
  return typeof call.input?.prompt === "string" ? call.input.prompt : null
}

/** The tools that spawn subagents (`Task` is its older name). */
export const SPAWN_TOOLS = new Set(["Agent", "Task"])
