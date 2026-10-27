import { Folder, FolderOpen } from "lucide-react"
import type { ReactNode } from "react"

import { Kbd } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { baseName, isMac } from "@/lib/utils"
import { useWorkspace } from "@/stores/workspace"

/** Recent folders plus "Open folder…", wrapped around any trigger. */
export function WorkspaceMenu({ children, align = "start" }: { children: ReactNode; align?: "start" | "center" }) {
  const { info, recent, open, pickAndOpen } = useWorkspace()

  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align={align} className="w-80">
        {recent.length > 0 && <MenuLabel>Recent</MenuLabel>}
        {recent.map((path) => (
          <MenuItem key={path} onSelect={() => void open(path)} disabled={path === info?.root}>
            <Folder />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{baseName(path)}</span>
              <span className="block truncate text-[11px] text-subtle-foreground">{path}</span>
            </span>
          </MenuItem>
        ))}
        {recent.length > 0 && <MenuSeparator />}
        <MenuItem onSelect={() => void pickAndOpen()}>
          <FolderOpen />
          <span className="flex-1">Open folder…</span>
          <Kbd>{isMac ? "⌘O" : "Ctrl+O"}</Kbd>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
