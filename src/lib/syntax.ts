/**
 * Code colouring for the file, diff and tool views, in two layers:
 *
 * 1. highlight.js (through lowlight) colours every line at once, in the browser.
 * 2. When a language server is running for the file, its semantic tokens are
 *    laid over the top (`withSemanticTokens`): it knows a parameter from a
 *    local, a type from a value, a mutable binding from an immutable one.
 *
 * Both layers name the same scopes, styled by the `tok-*` classes in
 * styles.css, so a line looks the same before and after the server answers,
 * only more exact.
 */
import { common, createLowlight } from "lowlight"

import type { SemanticTokens } from "@/bindings/SemanticTokens"

const lowlight = createLowlight(common)

/** A run of text in one style; `cls` is empty for plain text. */
export interface Segment {
  text: string
  cls: string
}
export type Line = Segment[]

/** Past this, highlighting a file costs more than it gives. */
const MAX_CHARS = 400_000

const BY_EXTENSION: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  pyi: "python",
  go: "go",
  lua: "lua",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "objectivec",
  mm: "objectivec",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  graphql: "graphql",
  gql: "graphql",
  r: "r",
  pl: "perl",
  diff: "diff",
  patch: "diff",
}

/** The highlight.js grammar for `path`, or null to leave it plain. */
export function languageOf(path: string): string | null {
  const name = path.split("/").pop() ?? ""
  if (name === "Makefile" || name === "makefile") return "makefile"
  const dot = name.lastIndexOf(".")
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null
}

/** highlight.js classes → Elaris scopes. `""` resets to plain (template substitutions). */
const HLJS_SCOPES: Record<string, string> = {
  keyword: "keyword",
  "variable.language_": "keyword",
  "selector-tag": "keyword",
  "template-tag": "keyword",
  name: "keyword",
  built_in: "type",
  type: "type",
  "title.class_": "type",
  "title.class_.inherited__": "type",
  "selector-class": "type",
  title: "function",
  "title.function_": "function",
  "title.function_.invoke__": "function",
  section: "function",
  "selector-id": "function",
  string: "string",
  regexp: "string",
  link: "string",
  addition: "string",
  "char.escape_": "escape",
  number: "number",
  literal: "constant",
  symbol: "constant",
  deletion: "number",
  comment: "comment",
  quote: "comment",
  doctag: "comment",
  meta: "macro",
  attr: "property",
  attribute: "property",
  property: "property",
  variable: "variable",
  "template-variable": "variable",
  params: "",
  subst: "",
  operator: "operator",
  punctuation: "punct",
  tag: "punct",
  bullet: "punct",
}

interface HastNode {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

/** Every line of `text`, coloured by highlight.js. Plain when the language is unknown or the text huge. */
export function highlightLines(text: string, language: string | null): Line[] {
  if (!language || text.length > MAX_CHARS || !lowlight.registered(language)) return plainLines(text)
  let tree: HastNode
  try {
    tree = lowlight.highlight(language, text) as unknown as HastNode
  } catch {
    return plainLines(text)
  }

  const lines: Line[] = [[]]
  const walk = (node: HastNode, cls: string) => {
    if (node.type === "text") {
      const parts = (node.value ?? "").split("\n")
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) push(lines[lines.length - 1], part, cls)
      })
      return
    }
    const scope = node.type === "element" ? hljsScope(node.properties?.className) : undefined
    const next = scope === undefined ? cls : scope ? `tok-${scope}` : ""
    for (const child of node.children ?? []) walk(child, next)
  }
  walk(tree, "")
  return lines
}

function hljsScope(className: unknown): string | undefined {
  if (!Array.isArray(className) || className.length === 0) return undefined
  const names = (className as string[]).map((c) => c.replace(/^hljs-/, ""))
  // Most specific first: "title.function_.invoke__", then "title.function_", then "title".
  for (let n = names.length; n > 0; n--) {
    const scope = HLJS_SCOPES[names.slice(0, n).join(".")]
    if (scope !== undefined) return scope
  }
  return undefined
}

function plainLines(text: string): Line[] {
  return text.split("\n").map((line) => (line ? [{ text: line, cls: "" }] : []))
}

function push(line: Line, text: string, cls: string) {
  const last = line[line.length - 1]
  if (last && last.cls === cls) last.text += text
  else line.push({ text, cls })
}

/* -------------------------------------------------------------------------- */
/* Semantic tokens                                                            */
/* -------------------------------------------------------------------------- */

/** LSP token types (standard and the common server-specific ones) → scopes. Unknown types keep the base colour. */
const LSP_SCOPES: Record<string, string> = {
  namespace: "namespace",
  module: "namespace",
  type: "type",
  class: "type",
  enum: "type",
  interface: "type",
  struct: "type",
  typeParameter: "type",
  typeAlias: "type",
  builtinType: "type",
  selfTypeKeyword: "type",
  concept: "type",
  parameter: "parameter",
  variable: "variable",
  property: "property",
  field: "property",
  event: "property",
  enumMember: "constant",
  constant: "constant",
  boolean: "constant",
  function: "function",
  method: "function",
  macro: "macro",
  decorator: "macro",
  attribute: "macro",
  builtinAttribute: "macro",
  derive: "macro",
  keyword: "keyword",
  selfKeyword: "keyword",
  modifier: "keyword",
  comment: "comment",
  string: "string",
  character: "string",
  regexp: "string",
  escapeSequence: "escape",
  formatSpecifier: "escape",
  number: "number",
  operator: "operator",
  lifetime: "label",
  label: "label",
  punctuation: "punct",
  bracket: "punct",
  brace: "punct",
  parenthesis: "punct",
  angle: "punct",
  comma: "punct",
  colon: "punct",
  semicolon: "punct",
  dot: "punct",
}

const MODIFIER_CLASSES: Record<string, string> = {
  mutable: "tok-mut",
  deprecated: "tok-deprecated",
  unsafe: "tok-unsafe",
}

interface Range {
  start: number
  end: number
  cls: string
}

/** `lines` with the server's tokens laid over them. Lines without tokens are returned as they were. */
export function withSemanticTokens(lines: Line[], tokens: SemanticTokens): Line[] {
  const ranges = new Map<number, Range[]>()
  const { data, types, modifiers } = tokens
  let line = 0
  let start = 0
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]
    line += deltaLine
    start = deltaLine === 0 ? start + data[i + 1] : data[i + 1]
    const cls = tokenClass(types[data[i + 3]], data[i + 4], modifiers)
    if (cls === null || line >= lines.length) continue
    let list = ranges.get(line)
    if (!list) ranges.set(line, (list = []))
    list.push({ start, end: start + data[i + 2], cls })
  }
  if (ranges.size === 0) return lines
  return lines.map((segments, i) => {
    const list = ranges.get(i)
    return list ? overlay(segments, list) : segments
  })
}

function tokenClass(type: string | undefined, bits: number, names: string[]): string | null {
  let scope = type ? LSP_SCOPES[type] : undefined
  if (scope === undefined) return null
  const mods: string[] = []
  for (let b = 0; bits >>> b && b < names.length; b++) {
    if ((bits >>> b) & 1) mods.push(names[b])
  }
  // Immutable statics and constants read as values, like literals.
  if ((scope === "variable" || scope === "property") && (mods.includes("constant") || (mods.includes("static") && mods.includes("readonly")))) {
    scope = "constant"
  }
  const classes = [`tok-${scope}`]
  for (const mod of mods) if (MODIFIER_CLASSES[mod]) classes.push(MODIFIER_CLASSES[mod])
  return classes.join(" ")
}

/** Splits `segments` at the ranges' edges; inside a range its class wins. */
function overlay(segments: Line, ranges: Range[]): Line {
  const out: Line = []
  let pos = 0
  let r = 0
  for (const seg of segments) {
    const segEnd = pos + seg.text.length
    let at = pos
    while (at < segEnd) {
      while (r < ranges.length && ranges[r].end <= at) r++
      const range = ranges[r]
      if (range && range.start <= at) {
        const end = Math.min(segEnd, range.end)
        push(out, seg.text.slice(at - pos, end - pos), range.cls)
        at = end
      } else {
        const end = range ? Math.min(segEnd, range.start) : segEnd
        push(out, seg.text.slice(at - pos, end - pos), seg.cls)
        at = end
      }
    }
    pos = segEnd
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Diffs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Colours for each line of a diff: the old and new sides are rebuilt and
 * highlighted as whole texts, so strings and comments that span lines stay
 * right. Entries are null for header lines (`---`, `@@`, …) when `headers` is set.
 */
export function highlightDiff(lines: string[], language: string | null, headers = false): (Line | null)[] {
  if (!language) return lines.map((line) => (isContent(line, headers) ? plainLines(line.slice(1))[0] : null))
  const before: string[] = []
  const after: string[] = []
  const where: ({ side: "before" | "after"; index: number } | null)[] = []
  let inHunk = !headers
  for (const line of lines) {
    if (headers && line.startsWith("@@")) {
      inHunk = true
      where.push(null)
      continue
    }
    if (headers && (!inHunk || line.startsWith("diff ") || line.startsWith("\\"))) {
      if (line.startsWith("diff ")) inHunk = false
      where.push(null)
      continue
    }
    const sign = line[0]
    const body = line.slice(1)
    if (sign === "-") {
      where.push({ side: "before", index: before.length })
      before.push(body)
    } else {
      where.push({ side: "after", index: after.length })
      after.push(body)
      if (sign !== "+") before.push(body)
    }
  }
  const coloured = {
    before: highlightLines(before.join("\n"), language),
    after: highlightLines(after.join("\n"), language),
  }
  return where.map((w) => (w ? (coloured[w.side][w.index] ?? []) : null))
}

function isContent(line: string, headers: boolean) {
  if (!headers) return true
  return !(/^(\+\+\+|---|diff |index |@@|\\)/.test(line))
}
