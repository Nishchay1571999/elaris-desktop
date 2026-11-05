import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"

import type { AgentEvent } from "@/bindings/AgentEvent"
import type { Message } from "@/bindings/Message"
import type { Part } from "@/bindings/Part"
import type { PermissionDecision } from "@/bindings/PermissionDecision"
import type { Session } from "@/bindings/Session"
import type { SessionSettings } from "@/bindings/SessionSettings"
import type { SessionSummary } from "@/bindings/SessionSummary"
import type { Subagent } from "@/bindings/Subagent"
import type { TokenUsage } from "@/bindings/TokenUsage"
import { errorMessage, ipc, type NewImage } from "@/lib/ipc"
import { useChatStatus } from "@/stores/chat-status"
import { usePreferences } from "@/stores/preferences"
import { useUi } from "@/stores/ui"

/** A message for a subagent, waiting to be sent. */
export interface QueuedInput {
  agent: string
  text: string
}

/**
 * A message the user sent that hasn't reached the chat yet: it waits for the running
 * reply to stop, or failed to send.
 */
export interface OutgoingMessage {
  key: string
  text: string
  images: NewImage[]
  status: "waiting" | "sending" | "failed"
}

export type SendResult = "sent" | "not-sent" | "no-chat"

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
  /** Messages for subagents waiting for the chat's reply to end, by chat id. */
  queued: Record<string, QueuedInput[]>
  /** The user's messages on their way into the chat, oldest first, by chat id. */
  outbox: Record<string, OutgoingMessage[]>
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
   * there is stopped first, so the message goes in mid-task; meanwhile it waits in
   * `outbox`, and anything else sent then goes along with it. Resolves once it went,
   * failed (it stays in `outbox` to retry) or was taken back; `no-chat` when the chat
   * couldn't be created, so the message is nowhere.
   */
  send: (sessionId: string | null, text: string, images?: NewImage[]) => Promise<SendResult>
  /** Sends a failed message from `outbox` again. */
  retry: (sessionId: string, key: string) => Promise<void>
  /** Takes a message back out of `outbox` before it goes; returns it, or null if it's already sending. */
  unsend: (sessionId: string, key: string) => OutgoingMessage | null
  /**
   * Sends `text` to subagent `agent` from its tab. Unlike `send` it never interrupts: while
   * a reply is running it waits in `queued` and goes once the reply ends.
   */
  sendToAgent: (sessionId: string, agent: string, text: string) => Promise<void>
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
  switch (event.type) {
    case "text-delta":
      return { ...message, content: message.content + event.delta, parts: fold(message.parts, event) }
    case "tool-start":
    case "tool-end":
      return { ...message, parts: fold(message.parts, event) }
    case "subagent-start":
      return updateSubagent(message, event.agent, (a) => ({
        ...a,
        status: "running",
        toolId: a.toolId ?? event.toolId,
        description: a.description || event.description,
      }))
    case "subagent":
      return updateSubagent(message, event.agent, (a) => ({ ...a, parts: fold(a.parts, event.event) }))
    case "subagent-input":
      return updateSubagent(message, event.agent, (a) => ({
        ...a,
        status: "running",
        parts: [...a.parts, { type: "input", text: event.text }],
      }))
    case "subagent-end":
      return updateSubagent(message, event.agent, (a) => ({ ...a, status: event.status, parts: failRunning(a.parts) }))
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

/** Folds a `text-delta`, `tool-start` or `tool-end` into `parts`. */
function fold(parts: Part[], event: AgentEvent): Part[] {
  switch (event.type) {
    case "text-delta": {
      const last = parts.at(-1)
      return last?.type === "text"
        ? [...parts.slice(0, -1), { ...last, text: last.text + event.delta }]
        : [...parts, { type: "text", text: event.delta }]
    }
    case "tool-start": {
      const { id, name, summary, input } = event
      return [...parts, { type: "tool", id, name, summary, input, status: "running", output: null }]
    }
    case "tool-end":
      return parts.map((p): Part =>
        p.type === "tool" && p.id === event.id ? { ...p, status: event.ok ? "done" : "failed", output: event.output } : p,
      )
    default:
      return parts
  }
}

/** Updates the reply's record of subagent `id`, adding it if it's new. */
function updateSubagent(message: Message, id: string, update: (agent: Subagent) => Subagent): Message {
  const found = message.agents.some((a) => a.id === id)
  const agents = found
    ? message.agents
    : [...message.agents, { id, toolId: null, description: "", status: "running" as const, parts: [] }]
  return { ...message, agents: agents.map((a) => (a.id === id ? update(a) : a)) }
}

function failRunning(parts: Part[]): Part[] {
  return parts.map((p): Part => (p.type === "tool" && p.status === "running" ? { ...p, status: "failed" } : p))
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
    parts: failRunning(message.parts),
    // The agent process they ran in is gone; their tabs stay, to resume them from.
    agents: message.agents.map((a) => ({
      ...a,
      status: a.status === "running" ? "stopped" : a.status,
      parts: failRunning(a.parts),
    })),
  }
}


const INTERRUPT_TIMEOUT_MS = 10_000

/** Chats whose live reply this window is receiving, so it never subscribes twice. */
const following = new Set<string>()

export const useSessions = create<SessionsState>()((set, get) => {
  const putSession = (session: Session) => set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }))
  /**
   * Updates a few fields of a loaded chat. The backend's copy of a streaming reply
   * lags the live one here, so a whole session from it would undo streamed events.
   */
  const mergeSession = (id: string, patch: Partial<Session>) =>
    set((s) => {
      const session = s.sessions[id]
      return session ? { sessions: { ...s.sessions, [id]: { ...session, ...patch } } } : {}
    })

  const endStream = (id: string) => {
    following.delete(id)
    set((s) => {
      const streaming = { ...s.streaming }
      const requests = { ...s.requests }
      delete streaming[id]
      delete requests[id]
      return { streaming, requests }
    })
    if (get().queued[id]?.length) void sendQueued(id)
  }

  /** Sends the oldest message queued for a subagent in `id`, once the backend is free too. */
  const sendQueued = async (id: string) => {
    try {
      await waitIdle(id)
    } catch {
      return // Something else started meanwhile; this runs again when it ends.
    }
    const [next, ...rest] = get().queued[id] ?? []
    if (!next || get().streaming[id]) return
    set((s) => ({ queued: { ...s.queued, [id]: rest } }))
    await startAgentSend(id, next)
  }

  const startAgentSend = async (id: string, { agent, text }: QueuedInput) => {
    try {
      const { result: session, ready } = await follow(id, (onEvent) => ipc.chat.sendAgent(id, agent, text, onEvent))
      putSession(session)
      ready()
    } catch (error) {
      endStream(id)
      set({ error: errorMessage(error) })
    }
  }

  /** Waits until no reply runs in `id`, here or in the backend. */
  const waitIdle = async (id: string) => {
    const deadline = Date.now() + INTERRUPT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!get().streaming[id] && !(await ipc.chat.running()).includes(id)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("The current reply didn't stop in time; try again")
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
      if (session)
        putSession({ ...session, usage: addUsage(session.usage, event.usage), context: event.context ?? session.context })
      return
    }
    if (event.type === "mode") {
      if (session) putSession({ ...session, mode: event.mode })
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
    await waitIdle(id)
  }

  const waiting = (id: string) => (get().outbox[id] ?? []).filter((m) => m.status === "waiting")

  /** Gives the outbox messages `keys` names in chat `id` a new status, or removes them (`null`). */
  const setOutgoing = (id: string, keys: string[], status: OutgoingMessage["status"] | null) =>
    set((s) => ({
      outbox: {
        ...s.outbox,
        [id]: (s.outbox[id] ?? []).flatMap((m) => (!keys.includes(m.key) ? [m] : status ? [{ ...m, status }] : [])),
      },
    }))

  /**
   * Sends what's waiting in `id`'s outbox: stops the running reply, then sends every
   * waiting message as one. Loops while more arrive.
   */
  const deliver = async (id: string) => {
    while (waiting(id).length > 0) {
      if (get().streaming[id]) {
        try {
          await interrupt(id)
        } catch (error) {
          // The old reply may still be running; leave its stream alone.
          setOutgoing(id, waiting(id).map((m) => m.key), "failed")
          set({ error: errorMessage(error) })
          return
        }
      }
      // Taken only now, so messages sent or taken back while the reply stopped count.
      const batch = waiting(id)
      if (batch.length === 0) return
      const keys = batch.map((m) => m.key)
      setOutgoing(id, keys, "sending")
      const text = batch.map((m) => m.text).filter(Boolean).join("\n\n")
      const images = batch.flatMap((m) => m.images)
      try {
        // Events can arrive before `send` resolves; hold them until the
        // session (with its empty reply) is in the store.
        const { result: session, ready } = await follow(id, (onEvent) => ipc.chat.send(id, text, images, onEvent))
        putSession(session)
        setOutgoing(id, keys, null)
        ready()
        void get().refresh()
      } catch (error) {
        endStream(id)
        setOutgoing(id, keys, "failed")
        set({ error: errorMessage(error) })
        return
      }
    }
  }

  /** Chats whose outbox is being delivered, so only one delivery runs per chat. */
  const delivering = new Map<string, Promise<void>>()

  /** Delivers `id`'s outbox until message `key` went, failed or was taken back. */
  const settle = async (id: string, key: string): Promise<SendResult> => {
    for (;;) {
      let run = delivering.get(id)
      if (!run) {
        run = deliver(id).finally(() => delivering.delete(id))
        delivering.set(id, run)
      }
      await run
      const message = get().outbox[id]?.find((m) => m.key === key)
      // Still waiting: it came in as the last delivery wound down.
      if (message?.status !== "waiting") return message ? "not-sent" : "sent"
    }
  }

  return {
    summaries: [],
    sessions: {},
    streaming: {},
    requests: {},
    queued: {},
    outbox: {},
    // A new chat starts from Settings → Chat; changing it in the composer sticks until the app quits.
    draft: usePreferences.getState().defaults,
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
      if (!id) {
        try {
          const created = await ipc.sessions.create(get().draft)
          putSession(created)
          id = created.id
          useUi.getState().replace({ sessionId: id, view: { kind: "chat" } })
        } catch (error) {
          set({ error: errorMessage(error) })
          return "no-chat"
        }
      }
      const message: OutgoingMessage = { key: crypto.randomUUID(), text, images, status: "waiting" }
      const chatId = id
      set((s) => ({ outbox: { ...s.outbox, [chatId]: [...(s.outbox[chatId] ?? []), message] } }))
      return settle(chatId, message.key)
    },

    retry: async (sessionId, key) => {
      setOutgoing(sessionId, [key], "waiting")
      await settle(sessionId, key)
    },

    unsend: (sessionId, key) => {
      const message = get().outbox[sessionId]?.find((m) => m.key === key)
      if (!message || message.status === "sending") return null
      setOutgoing(sessionId, [key], null)
      return message
    },

    sendToAgent: async (sessionId, agent, text) => {
      const input = { agent, text }
      if (!get().streaming[sessionId] && !get().queued[sessionId]?.length) return startAgentSend(sessionId, input)
      // Behind a running reply, or earlier messages still on their way: keep the order.
      set((s) => ({ queued: { ...s.queued, [sessionId]: [...(s.queued[sessionId] ?? []), input] } }))
      if (!get().streaming[sessionId]) await sendQueued(sessionId)
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
        const saved = await ipc.sessions.updateSettings(sessionId, { mode, model, permissions })
        mergeSession(sessionId, { mode: saved.mode, model: saved.model, permissions: saved.permissions })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    rename: async (id, title) => {
      try {
        mergeSession(id, { title: (await ipc.sessions.rename(id, title)).title })
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
        useChatStatus.getState().forget(id)
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
