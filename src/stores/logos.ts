import { useEffect } from "react"
import { create } from "zustand"

import { ipc } from "@/lib/ipc"

/**
 * Images for project logos as `data:` URLs, by file path: a folder's detected
 * favicon or `logo.*` (keyed by the folder) or an image the user picked (keyed
 * by the image). `null` means there's none; missing means not read yet.
 */
interface LogosState {
  detected: Record<string, string | null>
  picked: Record<string, string | null>
  /** Forgets a folder's logo so it's looked for again (e.g. after adding a favicon). */
  forget: (root: string) => void
}

export const useLogos = create<LogosState>()((set) => ({
  detected: {},
  picked: {},
  forget: (root) =>
    set((s) => {
      const { [root]: _, ...detected } = s.detected
      return { detected }
    }),
}))

const loading = new Set<string>()

function load(kind: "detected" | "picked", path: string) {
  const key = `${kind}:${path}`
  if (loading.has(key) || path in useLogos.getState()[kind]) return
  loading.add(key)
  const read = kind === "detected" ? ipc.workspace.logo(path) : ipc.workspace.imageDataUrl(path)
  read
    .catch(() => null)
    .then((url) => useLogos.setState((s) => ({ [kind]: { ...s[kind], [path]: url } })))
    .finally(() => loading.delete(key))
}

/** The folder's own favicon or logo, loaded on first use. */
export function useDetectedLogo(root: string | null | undefined): string | null | undefined {
  const url = useLogos((s) => (root ? s.detected[root] : null))
  useEffect(() => {
    if (root) load("detected", root)
  }, [root, url])
  return url
}

/** An image file the user picked as a logo, loaded on first use. */
export function usePickedImage(path: string | null): string | null | undefined {
  const url = useLogos((s) => (path ? s.picked[path] : null))
  useEffect(() => {
    if (path) load("picked", path)
  }, [path, url])
  return url
}
