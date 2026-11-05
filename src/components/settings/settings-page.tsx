import { getVersion } from "@tauri-apps/api/app"
import { Info, Keyboard, MessageSquare, Monitor, Moon, Palette, Sun } from "lucide-react"
import type { ComponentType } from "react"
import { type ReactNode, useEffect, useState } from "react"

import type { AgentMode } from "@/bindings/AgentMode"
import type { PermissionPolicy } from "@/bindings/PermissionPolicy"
import type { SessionSettings } from "@/bindings/SessionSettings"
import { ConnectGitHub } from "@/components/github/connect-github"
import { GithubMark } from "@/components/github/github-mark"
import { Segmented } from "@/components/ui/segmented"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { MODELS, MODES, PERMISSIONS } from "@/lib/models"
import { cn, isMac } from "@/lib/utils"
import { type Accent, usePreferences } from "@/stores/preferences"
import { useSessions } from "@/stores/sessions"
import { type SettingsSection, useUi } from "@/stores/ui"

import { KeyboardSettings } from "./keyboard-settings"

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "github", label: "GitHub", icon: GithubMark },
  { id: "about", label: "About", icon: Info },
]

/** Settings, one section at a time, with the sections listed down the left. */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const openSettings = useUi((s) => s.openSettings)

  return (
    <div className="flex h-full">
      <nav aria-label="Settings" className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border px-2 pt-9">
        <h1 className="px-2 pb-3 text-[13px] font-semibold">Settings</h1>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? "page" : undefined}
            onClick={() => openSettings(id)}
            className={cn(
              "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              section === id && "bg-muted text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 pt-9 pb-16">
          {section === "appearance" && <AppearanceSettings />}
          {section === "chat" && <ChatSettings />}
          {section === "keyboard" && <KeyboardSettings />}
          {section === "github" && <GitHubSettings />}
          {section === "about" && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}

export function SectionHeader({ title, summary, children }: { title: string; summary: string; children?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end gap-4">
      <div className="flex-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{summary}</p>
      </div>
      {children}
    </header>
  )
}

/** A bordered list of setting rows. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border rounded-xl border border-border bg-surface-elevated/40">{children}</div>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-6 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

const ACCENTS: Array<{ id: Accent; label: string; hue: number }> = [
  { id: "blue", label: "Blue", hue: 264 },
  { id: "violet", label: "Violet", hue: 295 },
  { id: "teal", label: "Teal", hue: 195 },
  { id: "green", label: "Green", hue: 150 },
  { id: "amber", label: "Amber", hue: 65 },
  { id: "rose", label: "Rose", hue: 10 },
]

function AppearanceSettings() {
  const p = usePreferences()

  return (
    <>
      <SectionHeader title="Appearance" summary="How Elaris looks on this computer." />
      <Rows>
        <Row label="Theme" hint="System follows your computer's light or dark setting.">
          <Segmented
            label="Theme"
            value={p.theme}
            onChange={(theme) => p.set({ theme })}
            options={[
              { value: "light", label: "Light", icon: <Sun /> },
              { value: "dark", label: "Dark", icon: <Moon /> },
              { value: "system", label: "System", icon: <Monitor /> },
            ]}
          />
        </Row>
        <Row label="Accent" hint="Buttons, links, focus rings and the streaming caret.">
          <div role="radiogroup" aria-label="Accent" className="flex items-center gap-1.5">
            {ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                role="radio"
                aria-checked={p.accent === accent.id}
                aria-label={accent.label}
                title={accent.label}
                onClick={() => p.set({ accent: accent.id })}
                style={{ background: `oklch(0.62 0.17 ${accent.hue})` }}
                className={cn(
                  "size-5 rounded-full outline-none ring-offset-2 ring-offset-surface focus-visible:ring-3 focus-visible:ring-ring/50",
                  p.accent === accent.id && "ring-2 ring-foreground/70",
                )}
              />
            ))}
          </div>
        </Row>
        <Row label="Chat text size" hint="Replies and your messages; code and tool rows keep their size.">
          <Segmented
            label="Chat text size"
            value={p.chatTextSize}
            onChange={(chatTextSize) => p.set({ chatTextSize })}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
            ]}
          />
        </Row>
        <Row label="Density" hint="Compact fits more of a long chat on screen.">
          <Segmented
            label="Density"
            value={p.density}
            onChange={(density) => p.set({ density })}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </Row>
        <Row label="Animations" hint="Messages sliding in and the blinking caret. Reduced Motion turns them off too.">
          <Switch aria-label="Animations" checked={p.animations} onCheckedChange={(animations) => p.set({ animations })} />
        </Row>
      </Rows>
    </>
  )
}

function ChatSettings() {
  const p = usePreferences()
  const setDefaults = (patch: Partial<SessionSettings>) => {
    const defaults = { ...p.defaults, ...patch }
    p.set({ defaults })
    // The new-chat screen picks it up straight away.
    useSessions.setState({ draft: defaults })
  }

  return (
    <>
      <SectionHeader title="Chat" summary="How you write to the agent, and how a new chat starts." />
      <Rows>
        <Row label="Send with" hint={`The other one adds a new line. Shift+Enter always does.`}>
          <Segmented
            label="Send with"
            value={p.sendKey}
            onChange={(sendKey) => p.set({ sendKey })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: isMac ? "⌘Enter" : "Ctrl+Enter" },
            ]}
          />
        </Row>
      </Rows>

      <h3 className="mt-8 mb-2 text-[13px] font-semibold">New chats start with</h3>
      <Rows>
        <Row label="Mode">
          <Select<AgentMode>
            label="Default mode"
            value={p.defaults.mode}
            onChange={(mode) => setDefaults({ mode })}
            options={(Object.keys(MODES) as AgentMode[]).map((id) => ({ value: id, label: MODES[id].label, hint: MODES[id].hint }))}
          />
        </Row>
        <Row label="Model">
          <Select
            label="Default model"
            value={p.defaults.model}
            onChange={(model) => setDefaults({ model })}
            options={MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint }))}
          />
        </Row>
        <Row label="Permissions">
          <Select<PermissionPolicy>
            label="Default permissions"
            value={p.defaults.permissions}
            onChange={(permissions) => setDefaults({ permissions })}
            options={(Object.keys(PERMISSIONS) as PermissionPolicy[]).map((id) => ({
              value: id,
              label: PERMISSIONS[id].label,
              hint: PERMISSIONS[id].hint,
            }))}
          />
        </Row>
      </Rows>
    </>
  )
}

function GitHubSettings() {
  return (
    <>
      <SectionHeader
        title="GitHub"
        summary="Pull requests go through the GitHub CLI on this computer, signed in as you. No Elaris server is involved."
      />
      <ConnectGitHub />
    </>
  )
}

function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null))
  }, [])

  return (
    <>
      <SectionHeader title="About" summary="Elaris Desktop: chat and coding with an agent, on your machine." />
      <Rows>
        <Row label="Version">
          <span className="font-mono text-xs text-muted-foreground">{version ?? "—"}</span>
        </Row>
        <Row label="Settings are stored" hint="On this machine only, alongside the app's other local data.">
          <span className="text-xs text-muted-foreground">Local</span>
        </Row>
      </Rows>
    </>
  )
}
