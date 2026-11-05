import { describe, expect, it } from "vitest"

import type { GraphCommit } from "@/bindings/GraphCommit"

import { layoutGraph } from "./graph"

const c = (sha: string, ...parents: string[]): GraphCommit => ({
  sha,
  parents,
  author: "",
  email: "",
  time: 0,
  refs: [],
  subject: sha,
})

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[0].top).toEqual([])
    expect(rows[1].top).toEqual([{ from: 0, to: 0, color: 0 }])
    expect(rows[2].bottom).toEqual([])
  })

  it("opens a lane for a merge's second parent and closes it where it joins", () => {
    //  m        merge of a and f
    //  | f      feature commit, parent b
    //  a |
    //  |/
    //  b
    const rows = layoutGraph([c("m", "a", "f"), c("f", "b"), c("a", "b"), c("b")])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0])
    // The merge branches out to lane 1.
    expect(rows[0].bottom).toContainEqual({ from: 0, to: 1, color: 1 })
    // At b both lanes end in its dot.
    expect(rows[3].top).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 0, color: 1 },
    ])
    expect(Math.max(...rows.map((r) => r.width))).toBe(2)
  })

  it("starts unrelated tips in free lanes and reuses lanes once they end", () => {
    const rows = layoutGraph([c("x"), c("y")])
    expect(rows.map((r) => r.lane)).toEqual([0, 0])
  })
})
