import type { PermissionPolicy } from "@/bindings/PermissionPolicy"

export const MOCK_MODEL = "mock"

export const MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable for coding and agents" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Fast and capable for everyday work" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Quickest, for small tasks" },
  { id: MOCK_MODEL, label: "Mock agent", hint: "Offline canned replies, no API use" },
]

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id
}

/** Short name for chips: "Opus 5.5". */
export function modelShortLabel(id: string): string {
  return modelLabel(id).replace(/^Claude /, "")
}

export const PERMISSIONS: Record<PermissionPolicy, { label: string; hint: string }> = {
  ask: { label: "Ask before edits", hint: "Approve each edit and command" },
  "accept-edits": { label: "Accept edits", hint: "Apply file edits; still ask for commands" },
  auto: { label: "Auto", hint: "A classifier approves routine actions, asks about risky ones" },
  bypass: { label: "Bypass permissions", hint: "Never ask. Only for folders you trust" },
}
