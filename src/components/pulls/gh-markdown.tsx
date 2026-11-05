import { convertFileSrc } from "@tauri-apps/api/core"
import { FileDown, ImageOff, LoaderCircle } from "lucide-react"
import { type ComponentProps, memo, type ReactNode, useEffect, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { CodeBlock } from "@/components/chat/markdown"
import type { GhAsset } from "@/lib/github"
import { ipc } from "@/lib/ipc"

/**
 * GitHub's own markup in pull request and issue text: the HTML it allows (`<img>`,
 * `<video>`, `<details>`…), cleaned, and every attachment loaded inline.
 */
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "video", "source", "audio", "picture"],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
    video: ["src", "poster", "width", "height"],
    audio: ["src"],
    source: ["src", "type"],
    // highlight.js classes on code.
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
  },
  // GitHub's markdown keeps ids as written; sanitize would prefix them.
  clobberPrefix: "",
}

/** Where GitHub keeps attachments dropped into a comment: images, videos and any other file. */
const ATTACHMENT =
  /^https:\/\/(github\.com\/(user-attachments\/(assets|files)\/|[^/]+\/[^/]+\/(assets|files)\/)|(private-)?user-images\.githubusercontent\.com\/)/

export const isAttachment = (url: string | undefined): boolean => !!url && ATTACHMENT.test(url)

const components: Components = {
  pre: CodeBlock,
  img: ({ src, alt, width }) => (typeof src === "string" ? <Attachment url={src} alt={alt} width={width} /> : null),
  video: ({ src, children }) => {
    const source = src ?? findSource(children)
    return typeof source === "string" ? <Attachment url={source} kind="video" /> : null
  },
  audio: ({ src }) => (typeof src === "string" ? <Attachment url={src} kind="audio" /> : null),
  // A bare attachment URL is how GitHub embeds videos and files; it renders it, not links it.
  a: ({ href, children, ...props }: ComponentProps<"a">) => {
    if (href && isAttachment(href)) {
      const text = textOf(children)
      return <Attachment url={href} label={text === href ? undefined : text || undefined} />
    }
    return (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          if (!href?.startsWith("http")) return
          e.preventDefault()
          void ipc.openUrl(href)
        }}
      >
        {children}
      </a>
    )
  },
}

export const GhMarkdown = memo(function GhMarkdown({ text }: { text: string }) {
  return (
    <div className="prose-elaris">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/* -------------------------------------------------------------------------- */
/* Attachments                                                                */
/* -------------------------------------------------------------------------- */

/** One download per URL for the app's life; the files themselves stay cached on disk. */
const downloads = new Map<string, Promise<GhAsset>>()
function download(url: string) {
  let pending = downloads.get(url)
  if (!pending) {
    pending = ipc.github.asset(url)
    pending.catch(() => downloads.delete(url))
    downloads.set(url, pending)
  }
  return pending
}

type Kind = "image" | "video" | "audio" | "file"

function kindOf(contentType: string, name: string): Kind {
  if (contentType.startsWith("image/")) return "image"
  if (contentType.startsWith("video/")) return "video"
  if (contentType.startsWith("audio/")) return "audio"
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name)) return "image"
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return "video"
  return "file"
}

/**
 * An image, video, audio clip or file from a pull request or issue, fetched through the
 * app (private repositories need the GitHub token) and shown as itself.
 */
function Attachment({
  url,
  alt,
  width,
  kind: hint,
  label,
}: {
  url: string
  alt?: string
  width?: string | number
  kind?: Kind
  label?: string
}) {
  const [asset, setAsset] = useState<GhAsset | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    download(url)
      .then((a) => live && setAsset(a))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [url])

  if (failed) {
    return (
      <a
        href={url}
        onClick={(e) => (e.preventDefault(), void ipc.openUrl(url))}
        className="inline-flex items-center gap-1.5 text-muted-foreground"
      >
        <ImageOff className="size-3.5" /> {label || alt || "Attachment"} (open on GitHub)
      </a>
    )
  }
  if (!asset) {
    return (
      <span className="my-2 flex h-40 max-w-md items-center justify-center gap-2 rounded-lg bg-surface-sunken text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Loading {hint === "video" ? "video" : "attachment"}…
      </span>
    )
  }

  const src = convertFileSrc(asset.path)
  const kind = kindOf(asset.contentType, asset.name)
  if (kind === "image") {
    return (
      <img
        src={src}
        alt={alt ?? label ?? asset.name}
        width={width}
        loading="lazy"
        className="my-2 block h-auto max-h-[70vh] max-w-full rounded-lg"
      />
    )
  }
  if (kind === "video") {
    return <video src={src} controls preload="metadata" className="my-2 block max-h-[70vh] max-w-full rounded-lg bg-black" />
  }
  if (kind === "audio") return <audio src={src} controls className="my-2 block w-full max-w-md" />
  return (
    <button
      type="button"
      onClick={() => void ipc.github.assetOpen(asset.path)}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-left text-[13px] hover:bg-muted"
    >
      <FileDown className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{label || asset.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(asset.size)}</span>
    </button>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(textOf).join("")
  return ""
}

function findSource(children: ReactNode): string | undefined {
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const src = (child as { props?: { src?: unknown } } | null)?.props?.src
    if (typeof src === "string") return src
  }
  return undefined
}
