import { Check, Copy } from "lucide-react"
import { type ComponentProps, memo, useState } from "react"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

/** Renders an assistant reply. Memoised: only the streaming message re-parses. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-elaris">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false)
  const code = children as { props?: { className?: string; children?: unknown } } | undefined
  const language = /language-(\S+)/.exec(code?.props?.className ?? "")?.[1]

  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const text = event.currentTarget.closest("[data-slot=code-block]")?.querySelector("pre")?.innerText ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div data-slot="code-block" className="overflow-hidden rounded-lg border border-border bg-surface-sunken">
      <div className="flex h-8 items-center justify-between border-b border-border px-3 font-mono text-[11px] text-subtle-foreground">
        <span>{language ?? "text"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre {...props} className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">
        {children}
      </pre>
    </div>
  )
}
