import {
  Archive,
  ArrowUp,
  Cpu,
  GitBranch,
  GitPullRequest,
  ImagePlus,
  MessageSquare,
  Mic,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareCheck,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { AgentMode } from "@/bindings/AgentMode";
import type { Branches } from "@/bindings/Branches";
import type { PermissionPolicy } from "@/bindings/PermissionPolicy";
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { CheckIcon, PrStateIcon } from "@/components/pulls/pr-bits";
import { useCreatePr } from "@/components/pulls/create-pr-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { checksSummary } from "@/lib/github";
import { type DraftImage, imageFiles, readImage } from "@/lib/images";
import { errorMessage, ipc } from "@/lib/ipc";
import { MODELS, MODES, modelShortLabel, PERMISSIONS } from "@/lib/models";
import { cn, isMac, relativeTime } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences";
import { useStash } from "@/stores/stash";
import { useGitHub } from "@/stores/github";
import {
  type OutgoingMessage,
  type PendingRequest,
  useSessions,
  useSettings,
} from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

import { useContextReferences } from "./context-picker";
import { PendingMessages } from "./pending-messages";
import { RequestDock, type RequestDockHandle } from "./request-dock";

const NO_REQUESTS: PendingRequest[] = [];

// Where the hero box sat when its first message went out. The docked box that
// replaces it reads this once and glides down from there.
let heroBox: DOMRect | null = null;

// Unsent text and images per chat ("new" for a chat not started yet), so a
// draft survives switching pages and chats. The text is also kept in
// localStorage so it survives quitting; images only last until then.
const drafts = new Map<string, { text: string; images: DraftImage[] }>();

const SAVED_DRAFTS = "elaris.drafts";

function savedDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SAVED_DRAFTS) ?? "{}");
  } catch {
    return {};
  }
}

function saveDraftText(key: string, text: string) {
  const all = savedDrafts();
  if (text.trim()) all[key] = text;
  else delete all[key];
  localStorage.setItem(SAVED_DRAFTS, JSON.stringify(all));
}


/**
 * The prompt box. `hero` is the new-chat screen's box; `docked` sits under a
 * transcript, with the agent's open question or
 * permission prompt docked on top of it.
 */
export function Composer({
  sessionId,
  variant,
}: {
  sessionId: string | null;
  variant: "hero" | "docked";
}) {
  const { send, stop, updateSettings } = useSessions();
  const streaming = useSessions((s) =>
    sessionId ? Boolean(s.streaming[sessionId]) : false,
  );
  const { mode, model } = useSettings(sessionId);
  const focusSignal = useUi((s) => s.composerFocus);
  const sendKey = usePreferences((s) => s.sendKey);
  const draftKey = sessionId ?? "new";
  const [text, setText] = useState(
    () => drafts.get(draftKey)?.text ?? savedDrafts()[draftKey] ?? "",
  );
  const [images, setImages] = useState<DraftImage[]>(
    () => drafts.get(draftKey)?.images ?? [],
  );
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dock = useRef<RequestDockHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const contexts = useContextReferences(text, setText, input);
  const requests = useSessions((s) =>
    sessionId ? (s.requests[sessionId] ?? NO_REQUESTS) : NO_REQUESTS,
  );
  const request = variant === "docked" ? requests[0] : undefined;
  // While the agent asks something, the box is where a free-form answer goes.
  const answering = request?.type === "question";

  useEffect(() => {
    input.current?.focus();
  }, [focusSignal, sessionId]);

  // Before paint, so the docked box never flashes at the bottom first.
  useLayoutEffect(() => {
    if (variant !== "docked") return;
    const from = heroBox;
    heroBox = null;
    if (!from || !box.current) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = box.current.getBoundingClientRect();
    // Glides down from the new-chat screen to the bottom of the conversation.
    root.current?.animate(
      [
        {
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
          width: `${from.width}px`,
        },
        { transform: "none", width: `${to.width}px` },
      ],
      { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [variant]);

  useEffect(() => {
    if (text === "" && images.length === 0) drafts.delete(draftKey);
    else drafts.set(draftKey, { text, images });
    saveDraftText(draftKey, text);
  }, [draftKey, text, images]);

  // Grow with content up to a cap, then scroll.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const addImages = async (files: File[]) => {
    const read = await Promise.allSettled(files.map(readImage));
    const added = read.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    setImages((current) => [...current, ...added]);
    const failed = read.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed) useSessions.setState({ error: errorMessage(failed.reason) });
    input.current?.focus();
  };

  const hasDraft = text.trim() !== "" || images.length > 0;
  // With a draft, sending mid-reply stops the reply and sends straight away;
  // with none, the button stops the reply.
  const canSend = answering ? text.trim() !== "" : hasDraft && !contexts.blocked;
  const showStop = streaming && !canSend;

  const submit = async () => {
    if (answering) {
      dock.current?.answerWithText(text);
      setText("");
      return;
    }
    if (!canSend) return;
    const [sentText, sentImages] = [text, images];
    if (variant === "hero")
      heroBox = box.current?.getBoundingClientRect() ?? null;
    // Cleared now: the box may unmount before its effect would clear it.
    drafts.delete(draftKey);
    saveDraftText(draftKey, "");
    setText("");
    setImages([]);
    // Until it's in the chat, the message shows over the box (`PendingMessages`).
    const result = await send(
      sessionId,
      sentText.trim(),
      sentImages.map(({ mediaType, name, data }) => ({
        mediaType,
        name,
        data,
      })),
    );
    if (result !== "sent") heroBox = null;
    // No chat to hold it: give the draft back rather than lose it.
    if (result === "no-chat") {
      drafts.set(draftKey, { text: sentText, images: sentImages });
      saveDraftText(draftKey, sentText);
      setText(sentText);
      setImages(sentImages);
    }
  };

  /** Puts a message that hasn't gone yet back in the box, ahead of any new draft. */
  const editPending = (message: OutgoingMessage) => {
    setText((current) =>
      current.trim() ? `${message.text}\n\n${current}` : message.text,
    );
    setImages((current) => [
      ...message.images.map((image) => ({
        ...image,
        key: crypto.randomUUID(),
        url: `data:${image.mediaType};base64,${image.data}`,
      })),
      ...current,
    ]);
    input.current?.focus();
  };

  // Only file drags count; dragging text within the box stays native.
  const hasFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");

  const ModeIcon = MODES[mode].icon;

  return (
    <div ref={root} className="w-full">
      {sessionId && (
        <PendingMessages sessionId={sessionId} onEdit={editPending} />
      )}
      <div ref={box} className="rounded-2xl shadow-composer">
        {request && sessionId && (
          <RequestDock
            ref={dock}
            sessionId={sessionId}
            request={request}
            waiting={requests.length - 1}
          />
        )}
        <div
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            void addImages(imageFiles(e.dataTransfer));
          }}
          className={cn(
            "relative rounded-2xl border border-input bg-surface-elevated transition-colors focus-within:border-brand/60",
            request && "rounded-t-none",
            dragging && "border-brand bg-brand-soft",
          )}
        >
          {!answering && contexts.menu}
          {contexts.chips}
          {images.length > 0 && (
            <ul
              aria-label="Attached images"
              className="flex flex-wrap gap-2 px-3 pt-3"
            >
              {images.map((image) => (
                <li key={image.key} className="group relative">
                  <img
                    src={image.url}
                    alt={image.name}
                    title={image.name}
                    className="size-14 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() =>
                      setImages((current) =>
                        current.filter((i) => i.key !== image.key),
                      )
                    }
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border-strong bg-popover text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={input}
            value={text}
            rows={variant === "hero" ? 2 : 1}
            onChange={(e) => {
              setText(e.target.value);
              contexts.track(e.target);
            }}
            onSelect={(e) => contexts.track(e.currentTarget)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData);
              if (files.length === 0) return;
              e.preventDefault();
              void addImages(files);
            }}
            onKeyDown={(e) => {
              if (!answering && contexts.onKeyDown(e)) return;
              const mod = isMac ? e.metaKey : e.ctrlKey;
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                (sendKey === "enter" || mod)
              ) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={
              variant === "hero"
                ? "Ask anything..."
                : answering
                  ? "Type a different answer…"
                  : "Reply, or type # for a saved chat, % for a saved PR or issue…"
            }
            aria-label="Message"
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <Tooltip label="Attach images">
              <button
                type="button"
                aria-label="Attach images"
                onClick={() => picker.current?.click()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ImagePlus className="size-4" />
              </button>
            </Tooltip>
            <StashMenu
              text={text}
              onStash={() => setText("")}
              onRestore={(restored) => {
                setText(restored);
                input.current?.focus();
              }}
            />
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void addImages(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />

            <Menu>
              <MenuTrigger asChild>
                <ChipButton>
                  <ModeIcon className="size-3.5" /> {MODES[mode].label}
                </ChipButton>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Mode</MenuLabel>
                {(Object.keys(MODES) as AgentMode[]).map((id) => (
                  <MenuCheckItem
                    key={id}
                    checked={id === mode}
                    onSelect={() =>
                      void updateSettings(sessionId, { mode: id })
                    }
                  >
                    <span className="flex-1">
                      <span className="block">{MODES[id].label}</span>
                      <span className="block text-[11px] text-subtle-foreground">
                        {MODES[id].hint}
                      </span>
                    </span>
                  </MenuCheckItem>
                ))}
              </MenuContent>
            </Menu>

            <Menu>
              <MenuTrigger asChild>
                <ChipButton>
                  <Cpu className="size-3.5" /> {modelShortLabel(model)}
                </ChipButton>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Model</MenuLabel>
                {MODELS.map((m) => (
                  <MenuCheckItem
                    key={m.id}
                    checked={m.id === model}
                    onSelect={() =>
                      void updateSettings(sessionId, { model: m.id })
                    }
                  >
                    <span className="flex-1">
                      <span className="block">{m.label}</span>
                      <span className="block text-[11px] text-subtle-foreground">
                        {m.hint}
                      </span>
                    </span>
                  </MenuCheckItem>
                ))}
              </MenuContent>
            </Menu>

            <div className="flex-1" />
            <PlannedControl
              label="Voice input"
              icon={<Mic className="size-4" />}
              iconOnly
            />
            {showStop ? (
              <button
                type="button"
                onClick={() => sessionId && void stop(sessionId)}
                aria-label="Stop reply"
                className="flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={
                  answering
                    ? "Send answer"
                    : streaming
                      ? "Stop reply and send"
                      : "Send"
                }
                title={streaming && !answering ? "Stop the reply and send this now" : undefined}
                className="flex size-7 items-center justify-center rounded-full bg-brand text-brand-foreground transition-opacity hover:opacity-90 disabled:bg-muted disabled:text-subtle-foreground"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      <Footer sessionId={sessionId} />
    </div>
  );
}

const PERMISSION_ICONS: Record<PermissionPolicy, typeof Shield> = {
  ask: Shield,
  "accept-edits": ShieldCheck,
  auto: ShieldCheck,
  bypass: ShieldAlert,
};

function Footer({ sessionId }: { sessionId: string | null }) {
  const branch = useWorkspace((s) => s.info?.branch);
  const workspaceRoot = useWorkspace((s) => s.info?.root ?? null);
  const { model, permissions } = useSettings(sessionId);
  const updateSettings = useSessions((s) => s.updateSettings);
  const PermissionIcon = PERMISSION_ICONS[permissions];
  const allowed = useAllowedRules();
  // Always-allow rules belong to the folder the chat runs in.
  const root =
    useSessions((s) => (sessionId ? s.sessions[sessionId]?.workspace : null)) ??
    workspaceRoot;

  return (
    <div className="mt-2 flex items-center gap-1 px-1 text-xs">
      <PlannedControl
        label="Interactive"
        icon={<MessageSquare className="size-3.5" />}
      />
      {model !== "mock" && (
        <Menu
          onOpenChange={(open) => open && root && void allowed.refresh(root)}
        >
          <MenuTrigger asChild>
            <ChipButton
              className={cn(
                "h-6 px-1.5",
                permissions === "bypass" && "text-destructive",
              )}
            >
              <PermissionIcon className="size-3.5" />{" "}
              {PERMISSIONS[permissions].label}
            </ChipButton>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Permissions</MenuLabel>
            {(Object.keys(PERMISSIONS) as PermissionPolicy[]).map((id) => (
              <MenuCheckItem
                key={id}
                checked={id === permissions}
                onSelect={() =>
                  void updateSettings(sessionId, { permissions: id })
                }
              >
                <span className="flex-1">
                  <span
                    className={cn(
                      "block",
                      id === "bypass" && "text-destructive",
                    )}
                  >
                    {PERMISSIONS[id].label}
                  </span>
                  <span className="block text-[11px] text-subtle-foreground">
                    {PERMISSIONS[id].hint}
                  </span>
                </span>
              </MenuCheckItem>
            ))}
            {root && allowed.rules.length > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>Always allowed in this folder</MenuLabel>
                {allowed.rules.map((rule) => (
                  <MenuItem
                    key={rule}
                    onSelect={(e) => {
                      e.preventDefault();
                      void allowed.forget(root, rule);
                    }}
                    className="group"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11.5px]"
                      title={rule}
                    >
                      {rule}
                    </span>
                    <X
                      aria-label={`Stop allowing ${rule}`}
                      className="opacity-0 group-data-[highlighted]:opacity-100"
                    />
                  </MenuItem>
                ))}
              </>
            )}
          </MenuContent>
        </Menu>
      )}
      <div className="flex-1" />
      <PlannedControl
        label="New Worktree"
        icon={<SquareCheck className="size-3.5" />}
      />
      {branch && (
        <>
          <PullRequestButton branch={branch} />
          <BranchMenu branch={branch} />
        </>
      )}
    </div>
  );
}

/** Opens a pull request from the current branch into the default branch. */
/**
 * The branch's pull request: its number and checks when one is open (opens it),
 * else a button that opens the new pull request dialog.
 */
function PullRequestButton({ branch }: { branch: string }) {
  const base = useWorkspace((s) => s.info?.defaultBranch) ?? "main";
  const pr = useGitHub((s) => s.branchPr);
  const navigate = useUi((s) => s.navigate);
  const createPr = useCreatePr();

  if (pr) {
    const checks = checksSummary(pr.statusCheckRollup);
    return (
      <Tooltip label={`#${pr.number}: ${pr.title}`}>
        <ChipButton
          className="h-6 px-1.5"
          onClick={() => navigate({ view: { kind: "pulls", number: pr.number } })}
        >
          <PrStateIcon state={pr.state} isDraft={pr.isDraft} className="size-3.5" />
          #{pr.number}
          {checks.state !== "none" && <CheckIcon state={checks.state} />}
        </ChipButton>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      label={
        branch === base
          ? `Branch off ${base} and open a pull request`
          : `Push ${branch} and open a pull request into ${base}`
      }
    >
      <ChipButton className="h-6 px-1.5" onClick={() => void createPr()}>
        <GitPullRequest className="size-3.5" />
        Pull request
      </ChipButton>
    </Tooltip>
  );
}

/** The current branch; opening it lists branches to switch to. */
function BranchMenu({ branch }: { branch: string }) {
  const switchBranch = useWorkspace((s) => s.switchBranch);
  const [branches, setBranches] = useState<Branches | null>(null);

  const load = async () => {
    try {
      setBranches(await ipc.git.branches());
    } catch (error) {
      useWorkspace.setState({ error: errorMessage(error) });
    }
  };

  return (
    <Menu onOpenChange={(open) => open && void load()}>
      <Tooltip label="Switch branch">
        <MenuTrigger asChild>
          <ChipButton className="h-6 px-1.5">
            <GitBranch className="size-3.5" /> {branch}
          </ChipButton>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="max-h-80 overflow-y-auto">
        <MenuLabel>Branches</MenuLabel>
        {branches?.local.map((name) => (
          <MenuCheckItem
            key={name}
            checked={name === branch}
            disabled={name === branch}
            onSelect={() => void switchBranch(name)}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </MenuCheckItem>
        ))}
        {branches && branches.remote.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Remote, checks out locally</MenuLabel>
            {branches.remote.map((name) => (
              <MenuCheckItem
                key={name}
                checked={false}
                onSelect={() => void switchBranch(name)}
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </MenuCheckItem>
            ))}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** The folder's always-allow rules, read when the Permissions menu opens. */
function useAllowedRules() {
  const [rules, setRules] = useState<string[]>([]);
  const run = async (load: Promise<string[]>) => {
    try {
      setRules(await load);
    } catch (error) {
      useSessions.setState({ error: errorMessage(error) });
    }
  };
  return {
    rules,
    refresh: (root: string) => run(ipc.permissions.list(root)),
    forget: (root: string, rule: string) =>
      run(ipc.permissions.forget(root, rule)),
  };
}

/** Visible but not built yet: disabled, with a tooltip saying so. */
function PlannedControl({
  label,
  icon,
  iconOnly,
}: {
  label: string;
  icon: ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <Tooltip label={`${label} · planned`}>
      <button
        type="button"
        aria-disabled
        aria-label={`${label} (planned)`}
        onClick={(e) => e.preventDefault()}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground opacity-55",
          iconOnly && "size-7 justify-center px-0",
        )}
      >
        {icon}
        {!iconOnly && label}
      </button>
    </Tooltip>
  );
}

/**
 * Puts the prompt aside to send later, or brings one back. Restoring swaps it
 * with whatever is in the box, so nothing typed is lost.
 */
function StashMenu({
  text,
  onStash,
  onRestore,
}: {
  text: string;
  onStash: () => void;
  onRestore: (text: string) => void;
}) {
  const { items, stash, take, clear } = useStash();
  const hasText = text.trim() !== "";

  return (
    <Menu>
      <Tooltip label="Stashed prompts">
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="Stashed prompts"
            className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Archive className="size-4" />
            {items.length > 0 && (
              <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" />
            )}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent className="w-72">
        <MenuItem
          disabled={!hasText}
          onSelect={() => {
            stash(text);
            onStash();
          }}
        >
          <Archive /> Stash this prompt
        </MenuItem>
        {items.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Stashed</MenuLabel>
            {items.map((item) => (
              <MenuItem
                key={item.id}
                onSelect={() => {
                  const restored = take(item.id);
                  if (!restored) return;
                  if (hasText) stash(text);
                  onRestore(restored.text);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{item.text}</span>
                <span className="shrink-0 text-[11px] text-subtle-foreground">
                  {relativeTime(item.createdAt)}
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={clear} className="text-muted-foreground">
              Clear stash
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function ChipButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
