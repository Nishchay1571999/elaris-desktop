import {
  ArrowUp,
  Bot,
  ChevronDown,
  ClipboardList,
  Cpu,
  Folder,
  GitBranch,
  ImagePlus,
  GitPullRequest,
  Infinity as InfinityIcon,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquareCheck,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { AgentMode } from "@/bindings/AgentMode";
import type { PermissionPolicy } from "@/bindings/PermissionPolicy";
import { PlannedTag } from "@/components/ui/button";
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspaceMenu } from "@/components/workspace/workspace-menu";
import { type DraftImage, imageFiles, readImage } from "@/lib/images";
import { errorMessage, ipc } from "@/lib/ipc";
import { MODELS, modelShortLabel, PERMISSIONS } from "@/lib/models";
import { cn } from "@/lib/utils";
import {
  type PendingRequest,
  useSessions,
  useSettings,
} from "@/stores/sessions";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

import { RequestDock, type RequestDockHandle } from "./request-dock";

const NO_REQUESTS: PendingRequest[] = [];

const MODES: Record<
  AgentMode,
  { label: string; icon: typeof Bot; hint: string }
> = {
  agent: {
    label: "Agent",
    icon: InfinityIcon,
    hint: "Works through the task on its own",
  },
  ask: {
    label: "Ask",
    icon: MessageCircleQuestion,
    hint: "Answers without changing files",
  },
  plan: {
    label: "Plan",
    icon: ClipboardList,
    hint: "Proposes a plan for you to approve",
  },
};

/**
 * The prompt box. `hero` adds the context chips shown on the new-chat screen;
 * `docked` sits under a transcript, with the agent's open question or
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
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dock = useRef<RequestDockHandle>(null);
  const requests = useSessions((s) =>
    sessionId ? (s.requests[sessionId] ?? NO_REQUESTS) : NO_REQUESTS,
  );
  const request = variant === "docked" ? requests[0] : undefined;
  // While the agent asks something, the box is where a free-form answer goes.
  const answering = request?.type === "question";

  useEffect(() => {
    input.current?.focus();
  }, [focusSignal, sessionId]);

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
  const canSend = answering ? text.trim() !== "" : hasDraft;
  const showStop = streaming && !canSend;

  const submit = async () => {
    if (answering) {
      dock.current?.answerWithText(text);
      setText("");
      return;
    }
    if (!canSend) return;
    const [sentText, sentImages] = [text, images];
    setText("");
    setImages([]);
    const ok = await send(
      sessionId,
      sentText.trim(),
      sentImages.map(({ mediaType, name, data }) => ({
        mediaType,
        name,
        data,
      })),
    );
    // Give the draft back rather than lose it.
    if (!ok) {
      setText(sentText);
      setImages(sentImages);
    }
  };

  // Only file drags count; dragging text within the box stays native.
  const hasFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");

  const ModeIcon = MODES[mode].icon;

  return (
    <div className="w-full">
      {variant === "hero" && <ContextChips />}

      <div className="rounded-xl shadow-composer">
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
            "rounded-xl border border-input bg-surface-elevated transition-colors focus-within:border-brand/60",
            request && "rounded-t-none",
            dragging && "border-brand bg-brand-soft",
          )}
        >
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
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData);
              if (files.length === 0) return;
              e.preventDefault();
              void addImages(files);
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={
              variant === "hero"
                ? "Pitch your idea"
                : answering
                  ? "Type a different answer…"
                  : "Reply…"
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

function ContextChips() {
  const info = useWorkspace((s) => s.info);

  return (
    <div className="mb-3 flex items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <OutlineChip>
            <Sparkles className="size-3.5" /> Elaris{" "}
            <ChevronDown className="size-3" />
          </OutlineChip>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Agent</MenuLabel>
          <MenuCheckItem checked>Elaris</MenuCheckItem>
          <MenuItem disabled>
            <span className="size-3.5" />
            <span className="flex-1">Other agents</span>
            <PlannedTag />
          </MenuItem>
        </MenuContent>
      </Menu>

      <WorkspaceMenu>
        <OutlineChip>
          <Folder className="size-3.5" /> {info?.name ?? "Open folder"}{" "}
          <ChevronDown className="size-3" />
        </OutlineChip>
      </WorkspaceMenu>

      <Tooltip label="Linking an issue or pull request is planned">
        <OutlineChip aria-disabled className="opacity-50">
          <GitPullRequest className="size-3.5" /> Issue/PR{" "}
          <ChevronDown className="size-3" />
        </OutlineChip>
      </Tooltip>
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
        <Tooltip label="Current branch">
          <span className="flex h-6 items-center gap-1 px-1.5 text-muted-foreground">
            <GitBranch className="size-3.5" /> {branch}
          </span>
        </Tooltip>
      )}
    </div>
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

function OutlineChip({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
