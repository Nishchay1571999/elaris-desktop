/**
 * The Source Control actions that need a choice or a name from the user:
 * the ones behind the panel's `…` menu, its context menus and the command
 * palette. Each asks through the quick pick, then runs through `useScm.run`,
 * so it shows progress, reports failures and refreshes afterwards.
 */
import {
  Archive,
  CircleDot,
  Cloud,
  GitBranch,
  GitBranchPlus,
  type LucideIcon,
  Plus,
  Tag,
} from "lucide-react"

import { errorMessage, ipc } from "@/lib/ipc"
import { addCoAuthors } from "@/lib/scm"
import { input, pick, pickMany, type QuickItem } from "@/stores/quick-input"
import { useScm } from "@/stores/scm"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

const scm = () => useScm.getState()
const run = <T>(label: string, action: (progress: (line: string) => void) => Promise<T>) => scm().run(label, action)
const currentBranch = () => scm().status?.branch ?? null
const fail = (message: string) => useWorkspace.setState({ error: message })

const branchName = (value: string) =>
  /^[^\s~^:?*[\\]+$/.test(value) && !value.includes("..") && !value.startsWith("-") && !value.endsWith(".lock") && !value.endsWith("/")
    ? null
    : "Branch names can't contain spaces, `..`, `~ ^ : ? * [ \\`, or end in `/` or `.lock`"

const item = <T>(label: string, value: T, icon: LucideIcon, extra: Partial<QuickItem<T>> = {}): QuickItem<T> => ({
  label,
  value,
  icon,
  ...extra,
})

// ---------------------------------------------------------------- branches

type CheckoutChoice = { kind: "branch"; name: string } | { kind: "tag"; name: string } | { kind: "new" } | { kind: "newFrom" }

/** VS Code's Checkout to…: a local, remote or tag ref, or a new branch. */
export async function checkoutTo() {
  const items = (async () => {
    const [branches, tags] = await Promise.all([ipc.git.branches(), ipc.git.tags().catch(() => [])])
    const current = currentBranch()
    const list: QuickItem<CheckoutChoice>[] = [
      item("Create new branch…", { kind: "new" }, Plus),
      item("Create new branch from…", { kind: "newFrom" }, GitBranchPlus),
      ...branches.local.map((name) =>
        item(name, { kind: "branch", name } as CheckoutChoice, GitBranch, {
          group: "Branches",
          hint: name === current ? "current" : undefined,
        }),
      ),
      ...branches.remote.map((name) => item(name, { kind: "branch", name } as CheckoutChoice, Cloud, { group: "Remote branches" })),
      ...tags.map((t) => item(t.name, { kind: "tag", name: t.name } as CheckoutChoice, Tag, { group: "Tags", hint: t.subject })),
    ]
    return list
  })()
  const choice = await pick(items, "Select a branch or tag to check out")
  if (!choice) return
  if (choice.kind === "new") return createBranch()
  if (choice.kind === "newFrom") return createBranchFrom()
  if (choice.kind === "tag") return run(`Checking out ${choice.name}…`, () => ipc.git.checkoutCommit(choice.name))
  await run(`Switching to ${choice.name}…`, () => ipc.git.switch(choice.name))
}

export async function createBranch(from?: string) {
  const name = await input({
    placeholder: "Branch name",
    prompt: from ? `A new branch from ${from}, checked out with your changes` : "A new branch from here, checked out with your changes",
    validate: branchName,
  })
  if (name) await run(`Creating ${name}…`, () => ipc.git.createBranch(name, from))
}

export async function createBranchFrom() {
  const from = await pickRef("Select a ref to create the branch from", { tags: true })
  if (from) await createBranch(from)
}

/** A branch (local or remote) or, with `tags`, a tag. */
async function pickRef(placeholder: string, options: { tags?: boolean; remote?: boolean; skipCurrent?: boolean } = {}) {
  const items = (async () => {
    const [branches, tags] = await Promise.all([ipc.git.branches(), options.tags ? ipc.git.tags() : Promise.resolve([])])
    const current = currentBranch()
    return [
      ...branches.local
        .filter((b) => !options.skipCurrent || b !== current)
        .map((name) => item(name, name, GitBranch, { group: "Branches", hint: name === current ? "current" : undefined })),
      ...(options.remote === false ? [] : branches.allRemote.map((name) => item(name, name, Cloud, { group: "Remote branches" }))),
      ...tags.map((t) => item(t.name, t.name, Tag, { group: "Tags", hint: t.subject })),
    ]
  })()
  return pick(items, placeholder)
}

export async function renameBranch() {
  const old = currentBranch()
  if (!old) return fail("Check out a branch to rename it")
  const name = await input({ placeholder: "New branch name", prompt: `Rename ${old}`, value: old, validate: branchName })
  if (name && name !== old) await run("Renaming branch…", () => ipc.git.renameBranch(old, name))
}

export async function deleteBranch() {
  const name = await pickRef("Select a branch to delete", { remote: false, skipCurrent: true })
  if (!name) return
  const done = await run(`Deleting ${name}…`, async () => {
    try {
      await ipc.git.deleteBranch(name)
      return true
    } catch (error) {
      if (!errorMessage(error).includes("not fully merged")) throw error
      return false
    }
  })
  if (done === false) {
    const force = await ipc.dialog.confirm(`${name} has commits that aren't merged anywhere. Delete it anyway?`, "Delete branch", "Delete")
    if (force) await run(`Deleting ${name}…`, () => ipc.git.deleteBranch(name, true))
  }
}

export async function deleteRemoteBranch() {
  const items = ipc.git.branches().then((b) => b.allRemote.map((name) => item(name, name, Cloud)))
  const name = await pick(items, "Select a remote branch to delete")
  if (!name) return
  if (await ipc.dialog.confirm(`Delete ${name} on the remote? Others who use it will lose it too.`, "Delete remote branch", "Delete")) {
    await run(`Deleting ${name}…`, () => ipc.git.deleteRemoteBranch(name))
  }
}

export async function mergeBranch() {
  const name = await pickRef(`Select a branch to merge into ${currentBranch() ?? "HEAD"}`, { tags: true, skipCurrent: true })
  if (name) await run(`Merging ${name}…`, () => ipc.git.merge(name))
}

export async function rebaseBranch() {
  const name = await pickRef(`Select a branch to rebase ${currentBranch() ?? "HEAD"} onto`, { skipCurrent: true })
  if (name) await run(`Rebasing onto ${name}…`, () => ipc.git.rebase(name))
}

export async function abortOperation() {
  const op = scm().status?.operation
  if (op && (await ipc.dialog.confirm(`Abort the ${op.replace("-", " ")}? Its changes so far are undone.`, "Abort", "Abort"))) {
    await run("Aborting…", () => ipc.git.abortOperation())
  }
}

export const continueOperation = () => run("Continuing…", () => ipc.git.continueOperation())

// ---------------------------------------------------------------- sync

export const fetch = (options: { all?: boolean; prune?: boolean } = {}) =>
  run(options.all ? "Fetching from all remotes…" : "Fetching…", (progress) => ipc.git.fetch(options, progress))

export const pull = (rebase = false) =>
  run(rebase ? "Pulling (rebase)…" : "Pulling…", (progress) => ipc.git.pull({ rebase }, progress))

export async function pullFrom() {
  const remote = await pickRemote("Select a remote to pull from")
  if (!remote) return
  const branches = ipc.git
    .branches()
    .then((b) => b.allRemote.filter((r) => r.startsWith(`${remote}/`)).map((r) => item(r, r.slice(remote.length + 1), Cloud)))
  const branch = await pick(branches, `Select a branch on ${remote} to pull`)
  if (branch) await run(`Pulling ${remote}/${branch}…`, (progress) => ipc.git.pull({ remote, branch }, progress))
}

export const push = (force = false) => {
  const status = scm().status
  const label = force ? "Force pushing…" : status && !status.upstream ? "Publishing branch…" : "Pushing…"
  return run(label, (progress) => ipc.git.push({ force }, progress))
}

export async function forcePush() {
  const ok = await ipc.dialog.confirm(
    "Overwrite the remote branch with yours? Uses --force-with-lease: it refuses if someone else pushed since your last fetch.",
    "Force push",
    "Force push",
  )
  if (ok) await push(true)
}

export async function pushTo() {
  const remote = await pickRemote("Select a remote to push to")
  if (remote) await run(`Pushing to ${remote}…`, (progress) => ipc.git.push({ remote }, progress))
}

/** Publishes a branch with no upstream, asking which remote when there are several. */
export async function publishBranch() {
  const remotes = await ipc.git.remotes()
  if (remotes.length === 0) {
    fail("This repository has no remote yet. Add one with Remote ▸ Add Remote…")
    return
  }
  const remote = remotes.length === 1 ? remotes[0].name : await pickRemote("Select a remote to publish the branch to")
  if (remote) await run("Publishing branch…", (progress) => ipc.git.push({ remote }, progress))
}

export const sync = (rebase = false) => run("Syncing…", (progress) => ipc.git.sync(rebase, progress))

async function pickRemote(placeholder: string) {
  const items = ipc.git.remotes().then((list) => list.map((r) => item(r.name, r.name, Cloud, { hint: r.fetchUrl })))
  return pick(items, placeholder)
}

export async function cloneRepository() {
  const url = await input({ placeholder: "Repository URL", prompt: "e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git" })
  if (!url) return
  const parent = await ipc.dialog.pickFolder("Choose where to put the clone")
  if (!parent) return
  const dest = await run("Cloning…", (progress) => ipc.git.clone(url, parent, progress))
  if (dest && (await ipc.dialog.confirm(`Cloned into ${dest}. Open it now?`, "Clone", "Open"))) {
    await useWorkspace.getState().open(dest)
  }
}

// ---------------------------------------------------------------- remotes

export async function addRemote() {
  const url = await input({ placeholder: "Remote URL", prompt: "The repository's URL, e.g. git@github.com:owner/repo.git" })
  if (!url) return
  const remotes = await ipc.git.remotes()
  const name = await input({
    placeholder: "Remote name",
    value: remotes.some((r) => r.name === "origin") ? "" : "origin",
    validate: (v) => (/\s/.test(v) ? "No spaces" : remotes.some((r) => r.name === v) ? `${v} already exists` : null),
  })
  if (name) await run(`Adding ${name}…`, () => ipc.git.addRemote(name, url))
}

export async function removeRemote() {
  const remote = await pickRemote("Select a remote to remove")
  if (remote && (await ipc.dialog.confirm(`Remove the remote ${remote}? Its remote branches go too.`, "Remove remote", "Remove"))) {
    await run(`Removing ${remote}…`, () => ipc.git.removeRemote(remote))
  }
}

export async function renameRemote() {
  const remote = await pickRemote("Select a remote to rename")
  if (!remote) return
  const name = await input({ placeholder: "New name", value: remote, validate: (v) => (/\s/.test(v) ? "No spaces" : null) })
  if (name && name !== remote) await run("Renaming remote…", () => ipc.git.renameRemote(remote, name))
}

// ---------------------------------------------------------------- commits

export async function undoLastCommit() {
  const message = await run("Undoing last commit…", () => ipc.git.undoLastCommit())
  // Put the message back, as VS Code does, unless something's being typed.
  if (message !== undefined && !scm().message.trim()) scm().setMessage(message)
}

export async function addCoAuthorsToMessage() {
  const people = await pickMany(
    ipc.git.authors().then((list) => list.map((who) => item(who, who, CircleDot))),
    "Select co-authors (⌘↩ to add)",
  )
  if (people.length) scm().setMessage(addCoAuthors(scm().message, people))
}

/** Fills the box with the last commit's message, for an amend. */
export async function editLastMessage() {
  try {
    scm().setMessage(await ipc.git.lastCommitMessage())
  } catch (error) {
    fail(errorMessage(error))
  }
}

// ---------------------------------------------------------------- stashes

export async function stash(options: { includeUntracked?: boolean; staged?: boolean } = {}) {
  const message = await input({ placeholder: "Stash message (optional)", prompt: "Press Enter with nothing typed for git's default" })
  if (message === null) return
  await run("Stashing…", () => ipc.git.stash({ ...options, message: message || null }))
}

/** Stashes without asking for a message. */
export const stashQuick = (options: { includeUntracked?: boolean; staged?: boolean } = {}) =>
  run("Stashing…", () => ipc.git.stash(options))

async function pickStash(placeholder: string) {
  const items = ipc.git.stashes().then((list) =>
    list.map((s) => item(s.message, s, Archive, { hint: `stash@{${s.index}}` })),
  )
  return pick(items, placeholder)
}

export async function applyStash(pop: boolean, latest = false) {
  const entry = latest ? ((await ipc.git.stashes())[0] ?? null) : await pickStash(`Select a stash to ${pop ? "pop" : "apply"}`)
  if (!entry) {
    if (latest) fail("There are no stashes")
    return
  }
  await run(pop ? "Popping stash…" : "Applying stash…", () => ipc.git.stashApply(entry.index, pop))
}

export async function dropStash() {
  const entry = await pickStash("Select a stash to drop")
  if (entry && (await ipc.dialog.confirm(`Drop “${entry.message}”? It can't be recovered.`, "Drop stash", "Drop"))) {
    await run("Dropping stash…", () => ipc.git.stashDrop(entry.index))
  }
}

export async function dropAllStashes() {
  const count = (await ipc.git.stashes()).length
  if (count === 0) return fail("There are no stashes")
  if (await ipc.dialog.confirm(`Drop all ${count} stashes? They can't be recovered.`, "Drop all stashes", "Drop all")) {
    await run("Dropping stashes…", () => ipc.git.stashClear())
  }
}

export async function viewStash() {
  const entry = await pickStash("Select a stash to view")
  if (entry) useUi.getState().navigate({ view: { kind: "stash", index: entry.index, message: entry.message } })
}

// ---------------------------------------------------------------- tags

export async function createTag(target?: string) {
  const name = await input({
    placeholder: "Tag name",
    prompt: target ? `Tag ${target.slice(0, 7)}` : "Tag the current commit",
    validate: (v) => (/\s|\.\.|[~^:?*[\\]/.test(v) ? "Tag names can't contain spaces, `..` or `~ ^ : ? * [ \\`" : null),
  })
  if (!name) return
  const message = await input({ placeholder: "Message (optional)", prompt: "A message makes it an annotated tag" })
  if (message === null) return
  await run(`Creating tag ${name}…`, () => ipc.git.createTag(name, message || undefined, target))
}

async function pickTag(placeholder: string) {
  return pick(
    ipc.git.tags().then((list) => list.map((t) => item(t.name, t.name, Tag, { hint: t.subject }))),
    placeholder,
  )
}

export async function deleteTag() {
  const name = await pickTag("Select a tag to delete")
  if (name) await run(`Deleting tag ${name}…`, () => ipc.git.deleteTag(name))
}

export async function deleteRemoteTag() {
  const remote = await pickRemote("Select the remote to delete the tag from")
  if (!remote) return
  const name = await pickTag(`Select a tag to delete on ${remote}`)
  if (name && (await ipc.dialog.confirm(`Delete the tag ${name} on ${remote}?`, "Delete remote tag", "Delete"))) {
    await run(`Deleting ${name} on ${remote}…`, () => ipc.git.deleteRemoteTag(remote, name))
  }
}

export const pushTags = () => run("Pushing tags…", (progress) => ipc.git.pushTags(undefined, progress))

// ---------------------------------------------------------------- commits from the graph

export const checkoutCommit = (sha: string) => run(`Checking out ${sha.slice(0, 7)}…`, () => ipc.git.checkoutCommit(sha))

export async function cherryPick(sha: string) {
  await run(`Cherry-picking ${sha.slice(0, 7)}…`, () => ipc.git.cherryPick(sha))
}

export async function revertCommit(sha: string) {
  if (await ipc.dialog.confirm(`Make a new commit that undoes ${sha.slice(0, 7)}?`, "Revert commit", "Revert")) {
    await run(`Reverting ${sha.slice(0, 7)}…`, () => ipc.git.revert(sha))
  }
}

// ---------------------------------------------------------------- views

export const showGraph = () => useUi.getState().navigate({ view: { kind: "graph" } })
export const showOutput = () => useUi.getState().navigate({ view: { kind: "gitOutput" } })
export const showCommit = (sha: string) => useUi.getState().navigate({ view: { kind: "commit", sha } })
