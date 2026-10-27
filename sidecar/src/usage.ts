import { getSessionMessages, getSubagentMessages, listSubagents } from "@anthropic-ai/claude-agent-sdk"

import type { TokenUsage } from "./protocol.js"

interface ApiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Every token an agent session has used, subagents included, from the SDK's
 * reading of its transcript. Null when the session isn't on this machine.
 */
export async function sessionUsage(sessionId: string): Promise<TokenUsage | null> {
  const main = await getSessionMessages(sessionId)
  if (main.length === 0) return null
  const subagents = await listSubagents(sessionId).catch(() => [] as string[])
  const nested = await Promise.all(subagents.map((agentId) => getSubagentMessages(sessionId, agentId).catch(() => [])))

  // One API response can be saved as several messages (one per content
  // block), each repeating its usage as it grew: keep the largest per response.
  const calls = new Map<string, Required<ApiUsage>>()
  for (const [index, entry] of [...main, ...nested.flat()].entries()) {
    if (entry.type !== "assistant") continue
    const message = entry.message as { id?: string; usage?: ApiUsage } | null
    if (!message?.usage) continue
    const key = message.id ?? `#${index}`
    const seen = calls.get(key)
    const u = message.usage
    calls.set(key, {
      input_tokens: Math.max(seen?.input_tokens ?? 0, u.input_tokens ?? 0),
      output_tokens: Math.max(seen?.output_tokens ?? 0, u.output_tokens ?? 0),
      cache_read_input_tokens: Math.max(seen?.cache_read_input_tokens ?? 0, u.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: Math.max(seen?.cache_creation_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0),
    })
  }

  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const u of calls.values()) {
    total.input += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    total.output += u.output_tokens
    total.cacheRead += u.cache_read_input_tokens
    total.cacheWrite += u.cache_creation_input_tokens
  }
  return total
}
