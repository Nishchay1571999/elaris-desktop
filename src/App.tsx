import { useEffect, useRef } from "react"
import { Group, Panel, type PanelImperativeHandle, Separator } from "react-resizable-panels"

import { TabHeader } from "@/components/chat/chat-header"
import { ChatView } from "@/components/chat/chat-view"
import { InstructionsPage } from "@/components/customizations/instructions-page"
import { McpPage } from "@/components/customizations/mcp-page"
import { PlannedPage } from "@/components/customizations/planned-page"
import { PluginsPage } from "@/components/customizations/plugins-page"
import { ConnectGitHubDialog } from "@/components/github/connect-github"
import { CommandPalette } from "@/components/palette/command-palette"
import { CreatePrDialog } from "@/components/pulls/create-pr-dialog"
import { TrackerPage } from "@/components/pulls/pulls-page"
import { SkillsPage } from "@/components/customizations/skills-page"
import { ToolsPage } from "@/components/customizations/tools-page"
import { SettingsPage } from "@/components/settings/settings-page"
import { Sidebar } from "@/components/sidebar/sidebar"
import { Titlebar } from "@/components/titlebar/titlebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DiffView } from "@/components/workspace/diff-view"
import { OpeningBar } from "@/components/workspace/opening-bar"
import { RightPanel } from "@/components/workspace/right-panel"
import { useCtrlClipboard } from "@/hooks/use-ctrl-clipboard"
import { useShortcuts } from "@/hooks/use-shortcuts"
import { type AgentTerminal, ipc } from "@/lib/ipc"
import { useGitHub } from "@/stores/github"
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

  // GitHub follows the open folder and its branch: its repo, and the branch's pull request.
  useEffect(() => {
    void useGitHub.getState().refreshStatus().then(() => useGitHub.getState().refreshRepo())
    return useWorkspace.subscribe((s, prev) => {
      if (s.info?.root !== prev.info?.root) {
        useGitHub.setState({ repo: undefined, branchPr: null })
        void useGitHub.getState().refreshRepo()
      } else if (s.info?.branch !== prev.info?.branch) {
        void useGitHub.getState().refreshBranchPr()
      }
    })
  }, [])

  useChatFolder()

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
      <CommandPalette />
      <CreatePrDialog />
      <ConnectGitHubDialog />
    </TooltipProvider>
  )
}

/**
 * Each chat has one folder: opening a chat selects the folder it works in. A new
 * chat keeps whatever folder is selected.
 */
function useChatFolder() {
  const { sessionId } = useCurrent()
  const folder = useSessions((s) =>
    sessionId ? (s.sessions[sessionId]?.workspace ?? s.summaries.find((c) => c.id === sessionId)?.workspace) : null,
  )
  const switching = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!folder) return
    // One switch at a time, so quickly clicking through chats lands on the last one's folder.
    switching.current = switching.current.then(async () => {
      if (useWorkspace.getState().info?.root === folder) return
      await useWorkspace.getState().open(folder, { keepNavigation: true })
    })
  }, [sessionId, folder])
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
    case "planned":
      return <CustomizationView item={view.item} />
    case "settings":
      return <SettingsPage section={view.section} />
    case "pulls":
    case "issues":
      // A tab beside the chat: the chat's tab bar stays over it.
      return (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <TabHeader sessionId={sessionId} />
          <div className="min-h-0 flex-1">
            <TrackerPage kind={view.kind === "pulls" ? "prs" : "issues"} repo={view.repo} number={view.number} />
          </div>
        </div>
      )
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
