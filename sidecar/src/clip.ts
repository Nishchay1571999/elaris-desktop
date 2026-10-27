/** Caps on what tool calls carry to the transcript, which is saved to disk. */
const MAX_CHARS = 16_000
const MAX_LINES = 400

/** Shortens `text` to the caps, noting how much was cut. */
export function clip(text: string): string {
  const lines = text.split("\n")
  let kept = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") : text
  if (kept.length > MAX_CHARS) kept = kept.slice(0, MAX_CHARS)
  if (kept.length === text.length) return text
  const more = lines.length - kept.split("\n").length
  return `${kept}\n… (${more > 0 ? `${more} more lines` : `${text.length - kept.length} more characters`})`
}

/** A tool input with every long string clipped, nested ones included. */
export function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  return clipValue(input) as Record<string, unknown>
}

function clipValue(value: unknown): unknown {
  if (typeof value === "string") return clip(value)
  if (Array.isArray(value)) return value.map(clipValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clipValue(v)]))
  }
  return value
}

/** The text of a `tool_result`'s content (a string or content blocks), clipped. */
export function toolOutput(content: unknown): string | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block): block is { type: "text"; text: string } => block?.type === "text")
            .map((block) => block.text)
            .join("\n")
        : ""
  return text ? clip(text) : null
}
