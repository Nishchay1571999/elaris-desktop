import { refreshTerminalThemes } from "@/lib/terminals"
import { usePreferences } from "@/stores/preferences"

const dark = matchMedia("(prefers-color-scheme: dark)")

/** Puts the appearance preferences on `<html>`, where styles.css picks them up. */
function apply() {
  const { theme, accent, density, chatTextSize, animations } = usePreferences.getState()
  const root = document.documentElement
  const isDark = theme === "dark" || (theme === "system" && dark.matches)
  const changed = root.classList.contains("dark") !== isDark || root.dataset.accent !== accent
  root.classList.toggle("dark", isDark)
  root.style.colorScheme = isDark ? "dark" : "light"
  root.dataset.accent = accent
  root.dataset.density = density
  root.dataset.chatText = chatTextSize
  root.dataset.animations = animations ? "on" : "off"
  // xterm takes plain colours, so terminals are told when the palette changes.
  if (changed) refreshTerminalThemes()
}

/** Applies the preferences now (call before the first render) and whenever they or the OS theme change. */
export function initAppearance() {
  apply()
  usePreferences.subscribe(apply)
  dark.addEventListener("change", apply)
}

/** The theme actually showing, for a toggle. */
export function isDarkShowing() {
  return document.documentElement.classList.contains("dark")
}
