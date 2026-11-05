/**
 * Lays out commits (newest first, children before parents) as a graph: each
 * commit gets a lane, and each row lists the line segments drawn through it.
 * Lanes keep their column for as long as they live, so lines stay straight.
 */
import type { GraphCommit } from "@/bindings/GraphCommit"

/** A line drawn downward across half a row, from lane `from` to lane `to`. */
export interface Segment {
  from: number
  to: number
  /** Lane whose colour the line takes. */
  color: number
}

export interface GraphRow {
  /** The commit's own lane. */
  lane: number
  /** Lines from the top of the row down to its middle. */
  top: Segment[]
  /** Lines from the middle of the row down to its bottom. */
  bottom: Segment[]
  /** How many lanes are in use around this row, for its width. */
  width: number
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  // lanes[i] is the commit lane i is heading to, or null when free.
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []

  const freeSlot = (after = 0) => {
    for (let i = after; i < lanes.length; i++) if (lanes[i] === null) return i
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha)
    if (lane === -1) lane = freeSlot()
    const before = [...lanes]

    // Every lane heading here ends here.
    const top: Segment[] = []
    before.forEach((target, i) => {
      if (target === null) return
      top.push(target === commit.sha ? { from: i, to: lane, color: i } : { from: i, to: i, color: i })
    })
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.sha) lanes[i] = null

    // The first parent carries on in this lane; others join a lane already
    // heading to them, or open one.
    const [first, ...rest] = commit.parents
    lanes[lane] = first ?? null
    const branchesTo = new Set<number>()
    for (const parent of rest) {
      const existing = lanes.indexOf(parent)
      if (existing !== -1) {
        branchesTo.add(existing)
      } else {
        const slot = freeSlot(lane + 1)
        lanes[slot] = parent
        branchesTo.add(slot)
      }
    }

    const bottom: Segment[] = []
    lanes.forEach((target, i) => {
      if (target === null) return
      if (i === lane) bottom.push({ from: lane, to: lane, color: lane })
      else if (branchesTo.has(i)) bottom.push({ from: lane, to: i, color: i })
      else bottom.push({ from: i, to: i, color: i })
    })

    while (lanes.length && lanes.at(-1) === null) lanes.pop()
    const width = Math.max(lane + 1, before.length, lanes.length)
    rows.push({ lane, top, bottom, width })
  }
  return rows
}

/** Lane colours; they read on both the light and dark themes. */
export const LANE_COLORS = [
  "oklch(0.65 0.17 255)",
  "oklch(0.7 0.17 150)",
  "oklch(0.72 0.16 60)",
  "oklch(0.65 0.2 330)",
  "oklch(0.7 0.13 200)",
  "oklch(0.65 0.2 25)",
  "oklch(0.7 0.15 100)",
  "oklch(0.62 0.17 290)",
]

export const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]
