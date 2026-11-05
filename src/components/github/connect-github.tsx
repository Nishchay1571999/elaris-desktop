import { Check, Copy, Download, ExternalLink, LoaderCircle, LogOut, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import type { SetupEvent } from "@/lib/github"
import { errorMessage, ipc } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { useGitHub } from "@/stores/github"

import { GithubMark } from "./github-mark"

const PRIMARY =
  "h-8 gap-2 bg-foreground px-3 text-background hover:bg-foreground/85 hover:text-background disabled:opacity-60"
const SECONDARY = "h-8 gap-2 border border-border-strong px-3 text-foreground"

type Step =
  | { kind: "idle" }
  | { kind: "installing"; log: string[] }
  | { kind: "signing-in"; code: string | null; url: string; log: string[] }

/**
 * Getting GitHub ready, without a terminal: install the GitHub CLI if it's
 * missing, sign in with a one-time code, or show who's signed in.
 */
export function ConnectGitHub({ compact = false, onReady }: { compact?: boolean; onReady?: () => void }) {
  const status = useGitHub((s) => s.status)
  const refreshStatus = useGitHub((s) => s.refreshStatus)
  const [step, setStep] = useState<Step>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!status) void refreshStatus()
  }, [status, refreshStatus])

  // Leaving mid sign-in stops gh waiting for a browser that will never come back.
  const signingIn = step.kind === "signing-in"
  const signingInRef = useRef(signingIn)
  signingInRef.current = signingIn
  useEffect(() => () => void (signingInRef.current && ipc.github.cancelLogin()), [])

  const append = (text: string) =>
    setStep((s) => (s.kind === "idle" ? s : { ...s, log: [...s.log, text].slice(-6) }))

  const install = async () => {
    setError(null)
    setStep({ kind: "installing", log: [] })
    try {
      await ipc.github.install((event) => event.type === "line" && append(event.text))
      await refreshStatus()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStep({ kind: "idle" })
    }
  }

  const signIn = async () => {
    setError(null)
    setStep({ kind: "signing-in", code: null, url: "https://github.com/login/device", log: [] })
    const onEvent = (event: SetupEvent) => {
      if (event.type === "code") setStep((s) => (s.kind === "signing-in" ? { ...s, code: event.code, url: event.url } : s))
      else append(event.text)
    }
    try {
      await ipc.github.login(onEvent)
      const next = await refreshStatus()
      await useGitHub.getState().refreshRepo()
      if (next?.user) onReady?.()
    } catch (e) {
      const message = errorMessage(e)
      if (!/cancelled/.test(message)) setError(message)
    } finally {
      setStep({ kind: "idle" })
    }
  }

  const signOut = async () => {
    setError(null)
    try {
      await ipc.github.logout()
      await refreshStatus()
      await useGitHub.getState().refreshRepo()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const copyCode = (code: string) =>
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  if (!status) {
    return (
      <Card compact={compact}>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Checking for the GitHub CLI…
        </p>
      </Card>
    )
  }

  // 1. gh isn't installed.
  if (!status.installed) {
    return (
      <Card compact={compact}>
        <Heading title="Install the GitHub CLI" />
        <p className="text-[13px] text-muted-foreground">
          Elaris uses GitHub's own command-line tool, <code className="font-mono text-xs">gh</code>, for pull requests.
          Everything runs on this computer, signed in as you.
        </p>
        {step.kind === "installing" && <Log lines={step.log} />}
        <div className="flex flex-wrap items-center gap-2">
          {status.brewAvailable ? (
            <Button className={PRIMARY} disabled={step.kind === "installing"} onClick={() => void install()}>
              {step.kind === "installing" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {step.kind === "installing" ? "Installing with Homebrew…" : "Install with Homebrew"}
            </Button>
          ) : (
            <Button className={PRIMARY} onClick={() => void ipc.openUrl("https://cli.github.com")}>
              <Download className="size-3.5" /> Download GitHub CLI
            </Button>
          )}
          <Button className={SECONDARY} disabled={step.kind === "installing"} onClick={() => void refreshStatus()}>
            <RefreshCw className="size-3.5" /> I've installed it
          </Button>
        </div>
        <ErrorLine error={error} />
      </Card>
    )
  }

  // 2. Installed, signed out (or signing in now).
  if (!status.user) {
    return (
      <Card compact={compact}>
        <Heading title="Sign in to GitHub" />
        {step.kind === "signing-in" ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              Enter this code on the GitHub page that just opened in your browser, then approve access.
            </p>
            <div className="flex items-center gap-3">
              <span
                aria-label="One-time code"
                className="selectable rounded-lg border border-border-strong bg-surface-sunken px-4 py-2 font-mono text-2xl font-semibold tracking-[0.2em]"
              >
                {step.code ?? "····-····"}
              </span>
              {step.code && (
                <Button className={SECONDARY} onClick={() => copyCode(step.code!)}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button className={PRIMARY} disabled={!step.code} onClick={() => void ipc.openUrl(step.url)}>
                <ExternalLink className="size-3.5" /> Open github.com/login/device
              </Button>
              <Button className={SECONDARY} onClick={() => void ipc.github.cancelLogin()}>
                Cancel
              </Button>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" /> Waiting for GitHub…
              </span>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              You'll get a one-time code to enter on github.com. Elaris never sees your password; the GitHub CLI keeps
              the token in your keychain.
            </p>
            <div>
              <Button className={PRIMARY} onClick={() => void signIn()}>
                <GithubMark className="size-3.5" /> Sign in with GitHub
              </Button>
            </div>
          </>
        )}
        <ErrorLine error={error} />
      </Card>
    )
  }

  // 3. Signed in.
  const user = status.user
  return (
    <Card compact={compact}>
      <div className="flex items-center gap-3">
        <img src={user.avatarUrl} alt="" className="size-10 rounded-full border border-border" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{user.name || user.login}</div>
          <div className="truncate text-xs text-muted-foreground">
            @{user.login} · GitHub CLI {status.version}
          </div>
        </div>
        <Button className={SECONDARY} onClick={() => void ipc.openUrl(user.url)}>
          <ExternalLink className="size-3.5" /> Profile
        </Button>
        <Button className={SECONDARY} onClick={() => void signOut()}>
          <LogOut className="size-3.5" /> Sign out
        </Button>
      </div>
      <ErrorLine error={error} />
    </Card>
  )
}

/** Shown when a GitHub action needs gh installed or a sign-in first. */
export function ConnectGitHubDialog() {
  const needsSetup = useGitHub((s) => s.needsSetup)
  const dismiss = useGitHub((s) => s.dismissSetup)
  return (
    <Dialog open={needsSetup !== null} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="w-[min(92vw,30rem)] p-1">
        <DialogTitle className="sr-only">Connect GitHub</DialogTitle>
        <DialogDescription className="sr-only">Install the GitHub CLI or sign in to continue</DialogDescription>
        <ConnectGitHub compact onReady={dismiss} />
      </DialogContent>
    </Dialog>
  )
}

function Card({ compact, children }: { compact: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl p-4", !compact && "border border-border bg-surface-elevated/40")}>
      {children}
    </div>
  )
}

function Heading({ title }: { title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <GithubMark /> {title}
    </h3>
  )
}

function Log({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <pre className="selectable max-h-28 overflow-hidden rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
      {lines.join("\n")}
    </pre>
  )
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="selectable text-xs text-destructive">{error}</p> : null
}
