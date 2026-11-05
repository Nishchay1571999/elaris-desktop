import { FolderOpen, ImageIcon } from "lucide-react"
import { type ReactNode, useState } from "react"

import { Kbd } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { useBinding } from "@/lib/commands"
import { formatBinding } from "@/lib/keybindings"
import { baseName } from "@/lib/utils"
import { useWorkspace } from "@/stores/workspace"

import { LogoDialog } from "./logo-dialog"
import { ProjectLogo } from "./project-logo"

/** Recent folders, "Open folder…" and the open project's logo, wrapped around any trigger. */
export function WorkspaceMenu({ children, align = "start" }: { children: ReactNode; align?: "start" | "center" }) {
  const { info, recent, open, pickAndOpen } = useWorkspace()
  const openKey = formatBinding(useBinding("workspace.open"))
  const [editingLogo, setEditingLogo] = useState(false)

  return (
    <>
      <Menu>
        <MenuTrigger asChild>{children}</MenuTrigger>
        <MenuContent align={align} className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
          {recent.length > 0 && <MenuLabel>Recent</MenuLabel>}
          {recent.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1 p-1">
              {recent.map((path) => (
                <MenuItem
                  key={path}
                  title={path}
                  onSelect={() => void open(path)}
                  disabled={path === info?.root}
                  className="flex-col justify-center gap-2 border border-border px-2 pt-3 pb-2 data-[disabled]:border-border-strong data-[disabled]:bg-accent/60 data-[disabled]:opacity-100 [&_svg]:size-[68%] [&_svg]:text-current"
                >
                  <span className="flex text-[40px]">
                    <ProjectLogo root={path} className="size-10" />
                  </span>
                  <span className="w-full truncate text-center text-[11px] text-muted-foreground">
                    {baseName(path)}
                  </span>
                </MenuItem>
              ))}
            </div>
          )}
          {recent.length > 0 && <MenuSeparator />}
          <MenuItem onSelect={() => void pickAndOpen()}>
            <FolderOpen />
            <span className="flex-1">Open folder…</span>
            {openKey && <Kbd>{openKey}</Kbd>}
          </MenuItem>
          {info && (
            <MenuItem onSelect={() => setEditingLogo(true)}>
              <ImageIcon />
              <span className="flex-1">Change logo…</span>
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {info && <LogoDialog root={info.root} open={editingLogo} onOpenChange={setEditingLogo} />}
    </>
  )
}
