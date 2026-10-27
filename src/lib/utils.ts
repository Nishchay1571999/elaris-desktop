import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Parent of a `/`-separated workspace path; `""` is the root. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" })

/** "now", "5m ago", "yesterday"… for sidebar timestamps. */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.round((epochMs - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return "now"
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), "hour")
  if (abs < 86400 * 7) return RELATIVE.format(Math.round(seconds / 86400), "day")
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
