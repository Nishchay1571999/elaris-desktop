import { describe, expect, it } from "vitest"

import { hunkPatch, splitHunks } from "./patch"

describe("splitHunks", () => {
  it("cuts a one-file diff into header and hunks, and rebuilds a single-hunk patch", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "@@ -9,1 +9,1 @@",
      "-nine",
      "+NINE",
      "",
    ].join("\n")
    const split = splitHunks(diff)
    expect(split.header).toHaveLength(4)
    expect(split.hunks).toHaveLength(2)
    expect(hunkPatch(split, split.hunks[1])).toBe(
      "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -9,1 +9,1 @@\n-nine\n+NINE\n",
    )
  })
})
