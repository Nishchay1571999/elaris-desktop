import { File, FileCode, FileImage, FileJson, FileText, Folder, FolderOpen, Info, Settings } from "lucide-react"

const CODE = new Set(["rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "swift", "c", "h", "cpp", "rb", "sh", "css", "html", "vue", "svelte", "sql", "lua", "zig"])
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "icns"])
const CONFIG = new Set(["toml", "yaml", "yml", "ini", "lock", "env"])

export function FileIcon({ name, isDir, open }: { name: string; isDir: boolean; open?: boolean }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground"
  if (isDir) return open ? <FolderOpen className={cls} /> : <Folder className={cls} />

  const lower = name.toLowerCase()
  if (lower.startsWith("readme")) return <Info className="size-3.5 shrink-0 text-brand" />
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  if (ext === "md" || ext === "mdx") return <FileText className="size-3.5 shrink-0 text-brand" />
  if (ext === "json") return <FileJson className={cls} />
  if (CODE.has(ext)) return <FileCode className={cls} />
  if (IMAGE.has(ext)) return <FileImage className={cls} />
  if (CONFIG.has(ext) || lower.startsWith(".")) return <Settings className={cls} />
  if (ext === "txt") return <FileText className={cls} />
  return <File className={cls} />
}
