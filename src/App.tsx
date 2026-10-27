import { useEffect, useRef } from "react"
import { Group, Panel, type PanelImperativeHandle, Separator } from "react-resizable-panels"

import { ChatView } from "@/components/chat/chat-view"
import { InstructionsPage } from "@/components/customizations/instructions-page"
import { McpPage } from "@/components/customizations/mcp-page"
import { PlannedPage } from "@/components/customizations/planned-page"
import { PluginsPage } from "@/components/customizations/plugins-page"
import { SkillsPage } from "@/components/customizations/skills-page"
import { ToolsPage } from "@/components/customizations/tools-page"
import { Sidebar } from "@/components/sidebar/sidebar"
import { Titlebar } from "@/components/titlebar/titlebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DiffView } from "@/components/workspace/diff-view"
import { FileView } from "@/components/workspace/file-view"
import { OpeningBar } from "@/components/workspace/opening-bar"
import { RightPanel } from "@/components/workspace/right-panel"
import { useCtrlClipboard } from "@/hooks/use-ctrl-clipboard"
import { useShortcuts } from "@/hooks/use-shortcuts"
import { type AgentTerminal, ipc } from "@/lib/ipc"
import { useSessions } from "@/stores/sessions"
import { type CustomizationId, useCurrent, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

export function App() {
  useShortcuts()
  useCtrlClipboard()

  useEffect(() => {
    void useSessions.getState().refresh()
    void useSessions.getState().resumeLive()
    void useWorkspace.getState().init()
    // Shells a reloaded window left behind have no tab any more.
    void ipc.terminal.closeAll()
  }, [])

  // Terminals the agent starts open as tabs beside their chat, including ones
  // still running from before the window reloaded.
  useEffect(() => {
    const show = ({ sessionId, id, title }: AgentTerminal) =>
      void useUi.getState().showAgentTerminal(sessionId, id, title, false)
    const unlisten = ipc.terminal.onAgentOpened(show)
    void ipc.terminal.agentList().then((terminals) => terminals.forEach(show))
    return () => void unlisten.then((stop) => stop())
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <OpeningBar />
        <Titlebar />
        <Panes />
        <ErrorToast />
      </div>
    </TooltipProvider>
  )
}

function Panes() {
  const { leftOpen, rightOpen, setLeftOpen, setRightOpen } = useUi()
  const left = useRef<PanelImperativeHandle>(null)
  const right = useRef<PanelImperativeHandle>(null)

  // Store → panels (titlebar buttons, shortcuts).
  useEffect(() => {
    syncPanel(left.current, leftOpen)
  }, [leftOpen])
  useEffect(() => {
    syncPanel(right.current, rightOpen)
  }, [rightOpen])

  return (
    <Group orientation="horizontal" className="min-h-0 flex-1">
      <Panel
        id="sidebar"
        panelRef={left}
        defaultSize={280}
        minSize={200}
        maxSize={420}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        // Panels → store (dragging a panel shut).
        onResize={(size) => setLeftOpen(size.inPixels > 0)}
      >
        <Sidebar />
      </Panel>
      <ResizeHandle />
      <Panel id="main" minSize={420}>
        <main className="h-full bg-surface">
          <MainView />
        </main>
      </Panel>
      <ResizeHandle />
      <Panel
        id="workspace"
        panelRef={right}
        defaultSize={320}
        minSize={220}
        maxSize={560}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => setRightOpen(size.inPixels > 0)}
      >
        <RightPanel />
      </Panel>
    </Group>
  )
}

function syncPanel(panel: PanelImperativeHandle | null, open: boolean) {
  if (!panel || panel.isCollapsed() === !open) return
  if (open) panel.expand()
  else panel.collapse()
}

function ResizeHandle() {
  return (
    <Separator className="relative w-px bg-border transition-colors outline-none hover:bg-brand/50 focus-visible:bg-brand data-[separator=active]:bg-brand" />
  )
}

function MainView() {
  const { sessionId, view } = useCurrent()
  switch (view.kind) {
    case "chat":
      return <ChatView sessionId={sessionId} />
    case "diff":
      return <DiffView key={view.path} path={view.path} />
    case "file":
      return <FileView key={view.path} path={view.path} />
    case "planned":
      return <CustomizationView item={view.item} />
  }
}

function CustomizationView({ item }: { item: CustomizationId }) {
  switch (item) {
    case "plugins":
      return <PluginsPage />
    case "mcp":
      return <McpPage />
    case "skills":
      return <SkillsPage />
    case "instructions":
      return <InstructionsPage />
    case "tools":
      return <ToolsPage />
    default:
      return <PlannedPage item={item} />
  }
}

function ErrorToast() {
  const sessionError = useSessions((s) => s.error)
  const workspaceError = useWorkspace((s) => s.error)
  const clear = useSessions((s) => s.clearError)
  const message = sessionError ?? workspaceError
  if (!message) return null

  return (
    <div
      role="alert"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-border-strong bg-popover px-3 py-2 text-[13px] shadow-xl"
    >
      <span className="flex-1 text-destructive">{message}</span>
      <button
        type="button"
        onClick={() => {
          clear()
          useWorkspace.setState({ error: null })
        }}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  )
}
