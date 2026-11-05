import { describe, expect, it } from "vitest"

import type { ScmFile } from "@/bindings/ScmFile"

import { addCoAuthors, buildTree, flatten, gitPaths, sortFiles } from "./scm"

const f = (path: string, kind: ScmFile["kind"] = "modified", origPath: string | null = null): ScmFile => ({ path, kind, origPath })

describe("buildTree", () => {
  it("puts folders first and folds single-folder chains", () => {
    const tree = buildTree([f("src/lib/a.ts"), f("src/lib/b.ts"), f("README.md"), f("src/main.ts")], "g")
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"])
    const src = tree[0]
    if (src.kind !== "folder") throw new Error("expected a folder")
    expect(src.files).toHaveLength(3)
    expect(src.children.map((n) => n.name)).toEqual(["lib", "main.ts"])

    const deep = buildTree([f("a/b/c/d.ts")], "g")
    expect(deep.map((n) => n.name)).toEqual(["a/b/c"])
  })
})

describe("helpers", () => {
  it("sorts by name, path or status", () => {
    const files = [f("z/a.ts", "deleted"), f("a/z.ts", "added")]
    expect(sortFiles(files, "path").map((x) => x.path)).toEqual(["a/z.ts", "z/a.ts"])
    expect(sortFiles(files, "name").map((x) => x.path)).toEqual(["z/a.ts", "a/z.ts"])
    expect(sortFiles(files, "status").map((x) => x.kind)).toEqual(["added", "deleted"])
  })

  it("includes both ends of a rename", () => {
    expect(gitPaths([f("new.ts", "renamed", "old.ts"), f("x.ts")])).toEqual(["new.ts", "old.ts", "x.ts"])
  })

  it("flattens groups with the most telling kind winning", () => {
    const status = {
      branch: "main",
      detached: null,
      unborn: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [f("a.ts", "added")],
      unstaged: [f("a.ts", "modified"), f("b.ts", "deleted")],
      untracked: [f("c.ts", "untracked")],
      conflicted: [],
      operation: null,
    }
    expect(flatten(status)).toEqual([
      { path: "a.ts", kind: "added" },
      { path: "b.ts", kind: "deleted" },
      { path: "c.ts", kind: "untracked" },
    ])
  })

  it("appends co-author trailers once", () => {
    const once = addCoAuthors("Fix it", ["Ann <a@x.io>"])
    expect(once).toBe("Fix it\n\nCo-authored-by: Ann <a@x.io>")
    expect(addCoAuthors(once, ["Ann <a@x.io>", "Bo <b@x.io>"])).toBe(
      "Fix it\n\nCo-authored-by: Ann <a@x.io>\nCo-authored-by: Bo <b@x.io>",
    )
  })
})
