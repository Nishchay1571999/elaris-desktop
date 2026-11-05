import {
  AppWindow,
  Atom,
  Bot,
  Box,
  Braces,
  Brain,
  Briefcase,
  Bug,
  Cable,
  Camera,
  ChartBar,
  Cloud,
  Code,
  Coffee,
  Compass,
  Cpu,
  Database,
  Flame,
  FlaskConical,
  Folder,
  Gamepad2,
  Gem,
  GitBranch,
  Globe,
  BookOpen,
  Hammer,
  Heart,
  House,
  Image,
  Key,
  Layers,
  Leaf,
  Lightbulb,
  type LucideIcon,
  Map as MapIcon,
  MessageSquare,
  Package,
  Palette,
  PenTool,
  Puzzle,
  Rocket,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Terminal,
  Wallet,
  Wrench,
  Zap,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { useDetectedLogo, usePickedImage } from "@/stores/logos"
import { usePreferences } from "@/stores/preferences"

/** Icons a project can wear, by name (stored in preferences, so names never change). */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  code: Code,
  braces: Braces,
  terminal: Terminal,
  rocket: Rocket,
  zap: Zap,
  sparkles: Sparkles,
  bot: Bot,
  brain: Brain,
  cpu: Cpu,
  atom: Atom,
  flask: FlaskConical,
  globe: Globe,
  "app-window": AppWindow,
  smartphone: Smartphone,
  server: Server,
  database: Database,
  cloud: Cloud,
  cable: Cable,
  layers: Layers,
  box: Box,
  package: Package,
  puzzle: Puzzle,
  "git-branch": GitBranch,
  bug: Bug,
  wrench: Wrench,
  hammer: Hammer,
  shield: Shield,
  key: Key,
  wallet: Wallet,
  "shopping-cart": ShoppingCart,
  "chart-bar": ChartBar,
  "message-square": MessageSquare,
  palette: Palette,
  "pen-tool": PenTool,
  image: Image,
  camera: Camera,
  "gamepad-2": Gamepad2,
  book: BookOpen,
  briefcase: Briefcase,
  house: House,
  map: MapIcon,
  compass: Compass,
  lightbulb: Lightbulb,
  leaf: Leaf,
  flame: Flame,
  sun: Sun,
  star: Star,
  heart: Heart,
  gem: Gem,
  coffee: Coffee,
}

/** Hues for monograms and icons; the same recipe as the accent swatches. */
export const LOGO_HUES = [264, 295, 330, 10, 40, 65, 120, 150, 195, 230]

export const logoColour = (hue: number) => `oklch(0.62 0.15 ${hue})`

/** A folder's name, worn as 1–2 letters: "elaris-desktop" → "ED", "Elaris" → "EL". */
export function monogramOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return letters.toUpperCase()
}

/** A hue picked from the path, so each project keeps the same colour. */
export function hueOf(path: string): number {
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return LOGO_HUES[Math.abs(hash) % LOGO_HUES.length]
}

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path

/**
 * A project's logo: the one the user chose, else the project's own favicon or
 * `logo.*`, else a coloured monogram of its name.
 */
export function ProjectLogo({ root, className }: { root: string; className?: string }) {
  const icon = usePreferences((s) => s.projectIcons[root])
  const detected = useDetectedLogo(icon ? null : root)
  const picked = usePickedImage(icon?.kind === "image" ? icon.path : null)

  const frame = cn("flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[22%]", className)

  if (icon?.kind === "image" && picked) return <img src={picked} alt="" className={cn(frame, "object-contain")} />
  if (icon?.kind === "emoji") return <span className={cn(frame, "text-[0.8em] leading-none")}>{icon.emoji}</span>
  if (icon?.kind === "icon") {
    const Icon = PROJECT_ICONS[icon.name] ?? Folder
    return (
      <span className={frame} style={{ background: logoColour(icon.color), color: "white" }}>
        <Icon className="size-[68%]" strokeWidth={2.25} />
      </span>
    )
  }
  if (!icon && detected) return <img src={detected} alt="" className={cn(frame, "object-contain")} />
  return (
    <Monogram
      text={icon?.kind === "monogram" ? icon.text : monogramOf(baseName(root))}
      hue={icon?.kind === "monogram" ? icon.color : hueOf(root)}
      className={frame}
    />
  )
}

export function Monogram({ text, hue, className }: { text: string; hue: number; className?: string }) {
  return (
    <span
      className={cn("font-semibold tracking-tight text-white select-none", className)}
      style={{ background: logoColour(hue), containerType: "size" }}
    >
      <span style={{ fontSize: text.length > 1 ? "48cqh" : "60cqh", lineHeight: 1 }}>{text}</span>
    </span>
  )
}
