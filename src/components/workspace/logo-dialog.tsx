import { Check, ImageUp, RotateCcw } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Segmented } from "@/components/ui/segmented"
import { errorMessage, ipc } from "@/lib/ipc"
import { baseName, cn } from "@/lib/utils"
import { useDetectedLogo, useLogos } from "@/stores/logos"
import { type ProjectIcon, usePreferences } from "@/stores/preferences"

import { hueOf, LOGO_HUES, logoColour, Monogram, monogramOf, PROJECT_ICONS, ProjectLogo } from "./project-logo"

type Mode = "auto" | "icon" | "emoji" | "monogram" | "image"

const EMOJI = ["🚀", "⚡️", "✨", "🔥", "🧠", "🤖", "🧪", "🛠️", "📦", "🌐", "📱", "💾", "🎨", "🎮", "📚", "💡", "🌱", "🦀", "🐍", "☕️", "💎", "⭐️", "❤️", "🏠"]

/**
 * Picks a project's logo, like t3code's project icon picker: its own favicon or
 * logo (Auto), an icon, an emoji, a monogram, or any image file.
 */
export function LogoDialog({ root, open, onOpenChange }: { root: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,30rem)] p-0" aria-describedby={undefined}>
        {open && <LogoEditor root={root} close={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function LogoEditor({ root, close }: { root: string; close: () => void }) {
  const current = usePreferences((s) => s.projectIcons[root])
  const setProjectIcon = usePreferences((s) => s.setProjectIcon)
  const detected = useDetectedLogo(root)
  const name = baseName(root)

  const [mode, setMode] = useState<Mode>(current?.kind ?? "auto")
  const [color, setColor] = useState(current && "color" in current ? current.color : hueOf(root))
  const [iconName, setIconName] = useState(current?.kind === "icon" ? current.name : "code")
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "🚀")
  const [text, setText] = useState(current?.kind === "monogram" ? current.text : monogramOf(name))
  const [image, setImage] = useState<{ path: string; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choice: ProjectIcon | null | undefined =
    mode === "auto"
      ? null
      : mode === "icon"
        ? { kind: "icon", name: iconName, color }
        : mode === "emoji"
          ? emoji.trim()
            ? { kind: "emoji", emoji: emoji.trim() }
            : undefined
          : mode === "monogram"
            ? text.trim()
              ? { kind: "monogram", text: text.trim().slice(0, 2).toUpperCase(), color }
              : undefined
            : image
              ? { kind: "image", path: image.path }
              : current?.kind === "image"
                ? current
                : undefined

  const pickImage = async () => {
    setError(null)
    try {
      const path = await ipc.dialog.pickImage()
      if (!path) return
      const url = await ipc.workspace.imageDataUrl(path)
      // Seed the cache so the logo shows at once everywhere.
      useLogos.setState((s) => ({ picked: { ...s.picked, [path]: url } }))
      setImage({ path, url })
      setMode("image")
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const save = () => {
    if (choice === undefined) return
    setProjectIcon(root, choice)
    close()
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <Preview root={root} mode={mode} choice={choice} image={image?.url} detected={detected} />
        <div className="min-w-0">
          <DialogTitle className="text-sm font-semibold">Project logo</DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">{name}</DialogDescription>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        <Segmented<Mode>
          label="Logo type"
          value={mode}
          onChange={setMode}
          className="self-start"
          options={[
            { value: "auto", label: "Auto" },
            { value: "icon", label: "Icon" },
            { value: "emoji", label: "Emoji" },
            { value: "monogram", label: "Letters" },
            { value: "image", label: "Image" },
          ]}
        />

        {mode === "auto" && (
          <p className="text-xs text-muted-foreground">
            {detected
              ? "Uses the project's own favicon or logo file."
              : "No favicon or logo file found (favicon.*, logo.*, icon.* at the top, in public/, assets/ and similar), so the project's initials show."}
          </p>
        )}

        {mode === "icon" && (
          <div role="radiogroup" aria-label="Icon" className="grid max-h-48 grid-cols-10 gap-1 overflow-y-auto">
            {Object.entries(PROJECT_ICONS).map(([id, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={iconName === id}
                aria-label={id}
                title={id}
                onClick={() => setIconName(id)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                  iconName === id && "bg-accent text-foreground ring-1 ring-border-strong",
                )}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        )}

        {mode === "emoji" && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-12 gap-1">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  aria-pressed={emoji === e}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-md text-base outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                    emoji === e && "bg-accent ring-1 ring-border-strong",
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
            <Field label="Or type any emoji" value={emoji} onChange={setEmoji} maxLength={8} />
          </div>
        )}

        {mode === "monogram" && <Field label="Letters" value={text} onChange={setText} maxLength={2} />}

        {(mode === "icon" || mode === "monogram") && (
          <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1.5">
            {LOGO_HUES.map((hue) => (
              <button
                key={hue}
                type="button"
                role="radio"
                aria-checked={color === hue}
                aria-label={`Colour ${hue}`}
                onClick={() => setColor(hue)}
                style={{ background: logoColour(hue) }}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                )}
              >
                {color === hue && <Check className="size-3" strokeWidth={3} />}
              </button>
            ))}
          </div>
        )}

        {mode === "image" && (
          <div className="flex items-center gap-3">
            <Button onClick={() => void pickImage()} className="border border-border-strong text-foreground">
              <ImageUp className="size-3.5" /> Choose image…
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {image ? baseName(image.path) : current?.kind === "image" ? baseName(current.path) : "SVG, PNG, ICO, JPEG or WebP, up to 2 MB"}
            </span>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Button onClick={() => useLogos.getState().forget(root)} title="Look for the project's favicon or logo again">
          <RotateCcw className="size-3.5" /> Rescan
        </Button>
        <div className="flex-1" />
        <Button onClick={close}>Cancel</Button>
        <Button
          onClick={save}
          disabled={choice === undefined}
          className="bg-brand px-3 text-brand-foreground hover:bg-brand/90 hover:text-brand-foreground"
        >
          Save
        </Button>
      </footer>
    </div>
  )
}

function Preview({
  root,
  mode,
  choice,
  image,
  detected,
}: {
  root: string
  mode: Mode
  choice: ProjectIcon | null | undefined
  image: string | undefined
  detected: string | null | undefined
}) {
  const box = "size-10 rounded-[22%] shrink-0"
  if (mode === "auto") {
    return detected ? (
      <img src={detected} alt="" className={cn(box, "object-contain")} />
    ) : (
      <Monogram text={monogramOf(baseName(root))} hue={hueOf(root)} className={cn(box, "flex items-center justify-center")} />
    )
  }
  if (mode === "image" && image) return <img src={image} alt="" className={cn(box, "object-contain")} />
  if (!choice) return <ProjectLogo root={root} className={box} />
  if (choice.kind === "emoji") return <span className={cn(box, "flex items-center justify-center text-2xl")}>{choice.emoji}</span>
  if (choice.kind === "monogram")
    return <Monogram text={choice.text} hue={choice.color} className={cn(box, "flex items-center justify-center")} />
  if (choice.kind === "icon") {
    const Icon = PROJECT_ICONS[choice.name]
    return (
      <span className={cn(box, "flex items-center justify-center text-white")} style={{ background: logoColour(choice.color) }}>
        {Icon && <Icon className="size-6" strokeWidth={2.25} />}
      </span>
    )
  }
  return <ProjectLogo root={root} className={box} />
}

function Field({ label, value, onChange, maxLength }: { label: string; value: string; onChange: (v: string) => void; maxLength: number }) {
  return (
    <label className="flex items-center gap-3 text-xs text-muted-foreground">
      {label}
      <input
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-24 rounded-md border border-input bg-surface-sunken px-2 text-[13px] text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </label>
  )
}
