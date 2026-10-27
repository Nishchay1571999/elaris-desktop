import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"

import type { AgentEvent } from "@/bindings/AgentEvent"
import type { Message } from "@/bindings/Message"
import type { Part } from "@/bindings/Part"
import type { PermissionDecision } from "@/bindings/PermissionDecision"
import type { Session } from "@/bindings/Session"
import type { SessionSettings } from "@/bindings/SessionSettings"
import type { SessionSummary } from "@/bindings/SessionSummary"
import type { TokenUsage } from "@/bindings/TokenUsage"
import { errorMessage, ipc, type NewImage } from "@/lib/ipc"
import { useUi } from "@/stores/ui"

/** A permission prompt or question from the agent, still waiting for the user. */
export type PendingRequest = Extract<AgentEvent, { type: "permission-request" | "question" }>

interface SessionsState {
  summaries: SessionSummary[]
  /** Full transcripts loaded so far, by id. */
  sessions: Record<string, Session>
  /** Ids of chats with a reply in flight. */
  streaming: Record<string, true>
  /** Permission prompts and questions waiting for the user, by chat id. */
  requests: Record<string, PendingRequest[]>
  /** Settings for the next chat, before it exists. */
  draft: SessionSettings
  error: string | null

  refresh: () => Promise<void>
  load: (id: string) => Promise<void>
  /** Replaces the chat's token count with a fresh one from the agent's transcript. */
  refreshUsage: (id: string) => Promise<void>
  /** Picks up replies still streaming from before this window (re)loaded. */
  resumeLive: () => Promise<void>
  /**
   * Sends in `sessionId`, or creates a chat first when it's `null`. A reply still running
   * there is stopped first, so the message goes in mid-task. Resolves false if it failed.
   */
  send: (sessionId: string | null, text: string, images?: NewImage[]) => Promise<boolean>
  stop: (id: string) => Promise<void>
  answerPermission: (sessionId: string, requestId: string, decision: PermissionDecision) => Promise<void>
  /** `answers` maps question text to answer; `null` skips. */
  answerQuestion: (sessionId: string, requestId: string, answers: Record<string, string> | null) => Promise<void>
  updateSettings: (sessionId: string | null, patch: Partial<SessionSettings>) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearError: () => void
}

/** Mirrors `Message::apply` in `crates/agent-protocol`. */
export function applyEvent(message: Message, event: AgentEvent): Message {
  const parts = [...message.parts]
  switch (event.type) {
    case "text-delta": {
      const last = parts.at(-1)
      if (last?.type === "text") parts[parts.length - 1] = { ...last, text: last.text + event.delta }
      else parts.push({ type: "text", text: event.delta })
      return { ...message, content: message.content + event.delta, parts }
    }
    case "tool-start": {
      const { id, name, summary, input } = event
      parts.push({ type: "tool", id, name, summary, input, status: "running", output: null })
      return { ...message, parts }
    }
    case "tool-end":
      return {
        ...message,
        parts: parts.map((p): Part =>
          p.type === "tool" && p.id === event.id ? { ...p, status: event.ok ? "done" : "failed", output: event.output } : p,
        ),
      }
    case "finish":
      return finish(message, "complete")
    case "stopped":
      return finish(message, "stopped")
    case "error":
      return { ...finish(message, "error"), error: event.message }
    default:
      return message
  }
}

/** Mirrors `TokenUsage`'s `+=` in `crates/agent-protocol`. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

function finish(message: Message, status: Message["status"]): Message {
  return {
    ...message,
    status,
    parts: message.parts.map((p): Part => (p.type === "tool" && p.status === "running" ? { ...p, status: "failed" } : p)),
  }
}

const DEFAULT_SETTINGS: SessionSettings = { mode: "agent", model: "claude-opus-5-5", permissions: "ask" }

const INTERRUPT_TIMEOUT_MS = 10_000

/** Chats whose live reply this window is receiving, so it never subscribes twice. */
const following = new Set<string>()

export const useSessions = create<SessionsState>()((set, get) => {
  const putSession = (session: Session) => set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }))

  const endStream = (id: string) => {
    following.delete(id)
    set((s) => {
      const streaming = { ...s.streaming }
      const requests = { ...s.requests }
      delete streaming[id]
      delete requests[id]
      return { streaming, requests }
    })
  }

  const handleEvent = (id: string, event: AgentEvent) => {
    if (event.type === "permission-request" || event.type === "question") {
      set((s) => ({ requests: { ...s.requests, [id]: [...(s.requests[id] ?? []), event] } }))
      return
    }
    if (event.type === "permission-resolved" || event.type === "question-resolved") {
      set((s) => ({
        requests: { ...s.requests, [id]: (s.requests[id] ?? []).filter((r) => r.requestId !== event.requestId) },
      }))
      return
    }

    const session = get().sessions[id]
    if (event.type === "usage") {
      if (session) putSession({ ...session, usage: addUsage(session.usage, event.usage) })
      return
    }
    const last = session?.messages.at(-1)
    if (!session || !last || last.role !== "assistant") return
    putSession({ ...session, messages: [...session.messages.slice(0, -1), applyEvent(last, event)] })

    if (event.type === "finish" || event.type === "stopped" || event.type === "error") {
      endStream(id)
      void get().refresh()
      // The live count can miss calls (a reload mid-reply); settle on the real total.
      void get().refreshUsage(id)
    }
  }

  /**
   * Starts a stream for `id` whose events arrive through `start`'s callback,
   * possibly before `start` resolves; they're held until `ready` runs.
   */
  const follow = async <T>(id: string, start: (onEvent: (event: AgentEvent) => void) => Promise<T>) => {
    let isReady = false
    const pending: AgentEvent[] = []
    following.add(id)
    set((s) => ({ streaming: { ...s.streaming, [id]: true } }))
    const result = await start((event) => {
      if (isReady) handleEvent(id, event)
      else pending.push(event)
    })
    const ready = () => {
      isReady = true
      pending.forEach((event) => handleEvent(id, event))
    }
    return { result, ready }
  }

  /** Follows a reply that was already streaming when this window loaded. */
  const attach = async (id: string) => {
    if (following.has(id)) return
    try {
      const session = await ipc.sessions.get(id)
      const { result: live, ready } = await follow(id, (onEvent) => ipc.chat.attach(id, onEvent))
      if (!live) {
        // It finished in the meantime; the saved copy is final.
        putSession(session)
        endStream(id)
        return
      }
      const messages = session.messages.map((m) => (m.id === live.reply.id ? live.reply : m))
      putSession({ ...session, messages })
      const open = live.pending.filter((e): e is PendingRequest => e.type === "permission-request" || e.type === "question")
      set((s) => ({ requests: { ...s.requests, [id]: open } }))
      ready()
    } catch (error) {
      endStream(id)
      set({ error: errorMessage(error) })
    }
  }

  /**
   * Stops the reply running in `id` and waits until it's over here (its last event folded
   * into the reply) and in the backend (free to start another). The agent resumes its own
   * session on the next send, so nothing it did is lost.
   */
  const interrupt = async (id: string) => {
    await ipc.chat.stop(id)
    const deadline = Date.now() + INTERRUPT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!get().streaming[id] && !(await ipc.chat.running()).includes(id)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("The current reply didn't stop in time; try again")
  }

  return {
    summaries: [],
    sessions: {},
    streaming: {},
    requests: {},
    draft: DEFAULT_SETTINGS,
    error: null,

    refresh: async () => {
      try {
        set({ summaries: await ipc.sessions.list() })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    load: async (id) => {
      if (get().sessions[id]) return
      try {
        const session = await ipc.sessions.get(id)
        // `attach` may have put a newer, live copy in meanwhile.
        if (!get().sessions[id]) putSession(session)
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    refreshUsage: async (id) => {
      try {
        const usage = await ipc.sessions.usage(id)
        const session = get().sessions[id]
        if (session) putSession({ ...session, usage })
      } catch (error) {
        // The header keeps the saved count; nothing else depends on it.
        console.warn("Couldn't refresh token usage", error)
      }
    },

    resumeLive: async () => {
      try {
        await Promise.all((await ipc.chat.running()).map(attach))
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    send: async (sessionId, text, images = []) => {
      let id = sessionId
      try {
        if (!id) {
          const created = await ipc.sessions.create(get().draft)
          putSession(created)
          id = created.id
          useUi.getState().replace({ sessionId: id, view: { kind: "chat" } })
        }

        if (get().streaming[id]) {
          try {
            await interrupt(id)
          } catch (error) {
            // The old reply may still be running; leave its stream alone.
            set({ error: errorMessage(error) })
            return false
          }
        }

        // Events can arrive before `send` resolves; hold them until the
        // session (with its empty reply) is in the store.
        const chatId = id
        const { result: session, ready } = await follow(chatId, (onEvent) => ipc.chat.send(chatId, text, images, onEvent))
        putSession(session)
        ready()
        void get().refresh()
        return true
      } catch (error) {
        if (id) endStream(id)
        set({ error: errorMessage(error) })
        return false
      }
    },

    stop: async (id) => {
      await ipc.chat.stop(id)
    },

    answerPermission: async (sessionId, requestId, decision) => {
      try {
        await ipc.chat.permission(sessionId, requestId, decision)
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    answerQuestion: async (sessionId, requestId, answers) => {
      try {
        await ipc.chat.answer(sessionId, requestId, answers)
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    updateSettings: async (sessionId, patch) => {
      if (!sessionId) {
        set((s) => ({ draft: { ...s.draft, ...patch } }))
        return
      }
      const session = get().sessions[sessionId]
      if (!session) return
      const { mode, model, permissions } = { ...session, ...patch }
      try {
        putSession(await ipc.sessions.updateSettings(sessionId, { mode, model, permissions }))
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    rename: async (id, title) => {
      try {
        putSession(await ipc.sessions.rename(id, title))
        await get().refresh()
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    remove: async (id) => {
      try {
        await ipc.sessions.remove(id)
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[id]
          return { sessions }
        })
        useUi.getState().forgetSession(id)
        await get().refresh()
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    clearError: () => set({ error: null }),
  }
})

/** The settings the composer shows: the chat's, or the draft for a new chat. */
export function useSettings(sessionId: string | null): SessionSettings {
  return useSessions(
    useShallow((s) => {
      const session = sessionId ? s.sessions[sessionId] : undefined
      return session ? { mode: session.mode, model: session.model, permissions: session.permissions } : s.draft
    }),
  )
}
