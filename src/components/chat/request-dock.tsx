import { Check, PenLine, ShieldQuestion, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { Question } from "@/bindings/Question";
import { cn } from "@/lib/utils";
import { type PendingRequest, useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";

import { toolLabel } from "./activity";
import { ToolDetail } from "./tool-detail";

/** The one filled action in the dock; greys out like the composer's send button until it can act. */
const PRIMARY =
  "h-7 rounded-md bg-brand px-3 text-xs font-medium text-brand-foreground transition-[opacity,transform] outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] disabled:bg-muted disabled:text-subtle-foreground";

type PermissionRequest = Extract<
  PendingRequest,
  { type: "permission-request" }
>;
type QuestionRequest = Extract<PendingRequest, { type: "question" }>;

/** Lets the composer answer the open question with whatever was typed in it. */
export interface RequestDockHandle {
  /** Takes `text` as the answer to the current question; empty text confirms what's picked. */
  answerWithText: (text: string) => void;
}

/**
 * The agent's open question or permission prompt, docked on top of the composer
 * so the transcript and the text box both stay in view. One request at a time;
 * the rest wait their turn.
 */
export const RequestDock = forwardRef<
  RequestDockHandle,
  { sessionId: string; request: PendingRequest; waiting: number }
>(function RequestDock({ sessionId, request, waiting }, ref) {
  return (
    <section
      aria-label={
        request.type === "question"
          ? "Elaris has a question"
          : `Allow ${toolLabel(request.toolName)}?`
      }
      className="flex max-h-[min(55vh,32rem)] animate-dock-in flex-col rounded-t-xl border border-b-0 border-input bg-surface-elevated"
    >
      {request.type === "question" ? (
        <QuestionPanel
          key={request.requestId}
          ref={ref}
          sessionId={sessionId}
          request={request}
          waiting={waiting}
        />
      ) : (
        <PermissionPanel
          key={request.requestId}
          sessionId={sessionId}
          request={request}
          waiting={waiting}
        />
      )}
    </section>
  );
});

/* -------------------------------------------------------------------------- */
/* Questions                                                                  */
/* -------------------------------------------------------------------------- */

interface Answer {
  picked: string[];
  /** Typed in the composer instead of (or, for multi-select, as well as) a listed option. */
  typed: string;
}

const EMPTY: Answer = { picked: [], typed: "" };
const valueOf = (a: Answer = EMPTY) =>
  [...a.picked, a.typed.trim()].filter(Boolean).join(", ");

const QuestionPanel = forwardRef<
  RequestDockHandle,
  { sessionId: string; request: QuestionRequest; waiting: number }
>(function QuestionPanel({ sessionId, request, waiting }, ref) {
  const answerQuestion = useSessions((s) => s.answerQuestion);
  const focusComposer = useUi((s) => s.focusComposer);
  const { questions } = request;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() =>
    questions.map(() => EMPTY),
  );
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const advanceTimer = useRef<number>(undefined);

  const question = questions[index];
  const last = index === questions.length - 1;
  const complete = answers.every((a) => valueOf(a) !== "");

  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

  // Each question opens with the keyboard on its picked option, or its first.
  useEffect(() => {
    const rows = optionRows(list.current);
    (
      rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0]
    )?.focus({ preventScroll: true });
  }, [index]);

  const submit = (final: Answer[]) => {
    if (sending) return;
    setSending(true);
    void answerQuestion(
      sessionId,
      request.requestId,
      Object.fromEntries(
        questions.map((q, i) => [q.question, valueOf(final[i])]),
      ),
    ).finally(() => setSending(false));
  };

  /** Moves on from the current question: to the next one still open, or sends when all are answered. */
  const advance = (final: Answer[], from = index) => {
    const open = final.findIndex((a, i) => i > from && valueOf(a) === "");
    const firstOpen = final.findIndex((a) => valueOf(a) === "");
    if (open !== -1) setIndex(open);
    else if (from < questions.length - 1) setIndex(from + 1);
    else if (firstOpen !== -1) setIndex(firstOpen);
    else submitButton.current?.focus();
  };

  const update = (i: number, answer: Answer) => {
    const next = answers.map((a, j) => (j === i ? answer : a));
    setAnswers(next);
    return next;
  };

  const pick = (label: string) => {
    const current = answers[index];
    if (question.multiSelect) {
      const picked = current.picked.includes(label)
        ? current.picked.filter((l) => l !== label)
        : [...current.picked, label];
      update(index, { ...current, picked });
      return;
    }
    const next = update(index, { picked: [label], typed: "" });
    // A beat to see the choice land before the next question slides in.
    window.clearTimeout(advanceTimer.current);
    const from = index;
    advanceTimer.current = window.setTimeout(() => advance(next, from), 140);
  };

  useImperativeHandle(ref, () => ({
    answerWithText(text) {
      const typed = text.trim();
      if (!typed) {
        if (complete && last) submit(answers);
        else if (valueOf(answers[index])) advance(answers);
        return;
      }
      const current = answers[index];
      const next = update(
        index,
        question.multiSelect ? { ...current, typed } : { picked: [], typed },
      );
      // A single question answered from the box goes straight back to the agent.
      if (
        next.every((a) => valueOf(a) !== "") &&
        (last || questions.length === 1)
      )
        submit(next);
      else advance(next);
    },
  }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    )
      return;
    const rows = optionRows(list.current);
    const at = rows.indexOf(document.activeElement as HTMLElement);

    if (e.key === "Escape") {
      e.preventDefault();
      void answerQuestion(sessionId, request.requestId, null);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (complete) submit(answers);
      else advance(answers);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    } else if (
      (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
      questions.length > 1
    ) {
      e.preventDefault();
      setIndex((i) =>
        Math.min(
          questions.length - 1,
          Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
        ),
      );
    } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const option = question.options[Number(e.key) - 1];
      if (!option) return;
      e.preventDefault();
      rows[Number(e.key) - 1]?.focus();
      pick(option.label);
    } else if (
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key !== " "
    ) {
      // Typing anywhere in the dock goes to the composer, which is the "something else" answer.
      focusComposer();
    }
  };

  const answer = answers[index];

  return (
    <div onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
      {questions.length > 1 && (
        <div
          role="tablist"
          aria-label="Questions"
          className="flex shrink-0 items-center gap-1 px-2 pt-2"
        >
          {questions.map((q, i) => {
            const done = valueOf(answers[i]) !== "";
            return (
              <button
                key={q.question}
                type="button"
                role="tab"
                aria-selected={i === index}
                tabIndex={i === index ? 0 : -1}
                onClick={() => setIndex(i)}
                className={cn(
                  "flex h-7 max-w-44 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                  i === index && "bg-muted text-foreground",
                )}
              >
                {done && <Check className="size-3.5 shrink-0 text-brand" />}
                <span className="truncate">{q.header || q.question}</span>
              </button>
            );
          })}
          <WaitingCount waiting={waiting} />
        </div>
      )}

      <div className="flex shrink-0 items-start gap-3 px-4 pt-3.5 pb-2">
        <h2 className="selectable min-w-0 flex-1 text-sm leading-5 font-medium text-pretty">
          {question.question}
        </h2>
        {questions.length === 1 && <WaitingCount waiting={waiting} />}
      </div>

      <div
        ref={list}
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-label={question.question}
        className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-2 pb-1"
      >
        {question.options.map((option, i) => (
          <OptionRow
            key={option.label}
            multi={question.multiSelect}
            checked={answer.picked.includes(option.label)}
            label={option.label}
            description={option.description}
            shortcut={i < 9 ? String(i + 1) : undefined}
            onSelect={() => pick(option.label)}
          />
        ))}
        {answer.typed ? (
          <OptionRow
            multi={question.multiSelect}
            checked
            label={answer.typed}
            description="Your answer"
            onSelect={() => update(index, { ...answer, typed: "" })}
            trailing={
              <X
                aria-label="Clear your answer"
                className="size-3.5 text-subtle-foreground"
              />
            }
          />
        ) : (
          <button
            type="button"
            data-option
            onClick={focusComposer}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
          >
            <PenLine className="size-4 shrink-0" />
            Something else? Type it in the box below
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-3">
        <p className="min-w-0 flex-1 truncate text-[11.5px] text-subtle-foreground">
          {hintFor(question)}
          {questions.length > 1 && " · ←→ switch question"}
        </p>
        <button
          type="button"
          onClick={() =>
            void answerQuestion(sessionId, request.requestId, null)
          }
          className="h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Skip
        </button>
        {questions.length > 1 && !last && !complete ? (
          <button
            type="button"
            disabled={!valueOf(answer)}
            onClick={() => advance(answers)}
            className={PRIMARY}
          >
            Next
          </button>
        ) : (
          <button
            ref={submitButton}
            type="button"
            disabled={!complete || sending}
            onClick={() => submit(answers)}
            className={PRIMARY}
          >
            {questions.length > 1 ? "Send answers" : "Send answer"}
          </button>
        )}
      </div>
    </div>
  );
});

function hintFor(question: Question) {
  const n = Math.min(question.options.length, 9);
  const keys = n > 1 ? `1–${n}` : "1";
  return question.multiSelect
    ? `${keys} toggle · ⌘↵ confirm · esc skip`
    : `${keys} pick · ↑↓ move · esc skip`;
}

function optionRows(list: HTMLElement | null) {
  return list
    ? Array.from(list.querySelectorAll<HTMLElement>("[data-option]"))
    : [];
}

function OptionRow({
  multi,
  checked,
  label,
  description,
  shortcut,
  trailing,
  onSelect,
}: {
  multi: boolean;
  checked: boolean;
  label: string;
  description: string;
  shortcut?: string;
  trailing?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-option
      role={multi ? "checkbox" : "radio"}
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50",
        checked && "bg-muted",
      )}
    >
      <Indicator multi={multi} checked={checked} />
      <span className="min-w-0 flex-1">
        <span className="selectable block text-[13px] leading-5 font-medium break-words text-foreground">
          {label}
        </span>
        {description && (
          <span className="block text-[12.5px] leading-[18px] text-muted-foreground text-pretty">
            {description}
          </span>
        )}
      </span>
      {trailing ??
        (shortcut && (
          <span
            aria-hidden
            className="mt-0.5 w-3 shrink-0 text-right text-[11.5px] leading-4 text-subtle-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {shortcut}
          </span>
        ))}
    </button>
  );
}

/** A radio dot or a checkbox tick, drawn so it follows the theme. */
function Indicator({ multi, checked }: { multi: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center border transition-colors",
        multi ? "rounded-[4px]" : "rounded-full",
        checked ? "border-brand bg-brand" : "border-border-strong bg-surface",
      )}
    >
      {multi ? (
        <Check
          strokeWidth={3}
          className={cn(
            "size-2.5 text-brand-foreground transition-transform",
            checked ? "scale-100" : "scale-0",
          )}
        />
      ) : (
        <span
          className={cn(
            "size-1.5 rounded-full bg-brand-foreground transition-transform",
            checked ? "scale-100" : "scale-0",
          )}
        />
      )}
    </span>
  );
}

function WaitingCount({ waiting }: { waiting: number }) {
  if (waiting < 1) return null;
  return (
    <span className="ml-auto shrink-0 pt-0.5 pr-2 text-[11.5px] text-subtle-foreground tabular-nums">
      {waiting} more after this
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Permission prompts                                                         */
/* -------------------------------------------------------------------------- */

function PermissionPanel({
  sessionId,
  request,
  waiting,
}: {
  sessionId: string;
  request: PermissionRequest;
  waiting: number;
}) {
  const answer = useSessions((s) => s.answerPermission);
  const [sending, setSending] = useState(false);
  const allowButton = useRef<HTMLButtonElement>(null);
  const rules = request.always?.join(", ");

  useEffect(() => allowButton.current?.focus({ preventScroll: true }), []);

  const decide = (decision: "allow" | "always" | "deny") => {
    if (sending) return;
    setSending(true);
    void answer(sessionId, request.requestId, decision).finally(() =>
      setSending(false),
    );
  };

  return (
    <div
      role="alertdialog"
      aria-label={`Allow ${toolLabel(request.toolName)}?`}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        decide("deny");
      }}
      className="flex min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2">
        <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-medium">
          Allow {toolLabel(request.toolName)}?
        </h2>
        {request.summary && (
          <code
            className="selectable min-w-0 truncate font-mono text-xs text-muted-foreground"
            title={request.summary}
          >
            {request.summary}
          </code>
        )}
        <WaitingCount waiting={waiting} />
      </div>
      <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-1">
        <ToolDetail name={request.toolName} input={request.input} />
      </div>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-3">
        <p className="min-w-0 flex-1 truncate text-[11.5px] text-subtle-foreground">
          ↵ allow · esc deny
        </p>
        <button
          type="button"
          disabled={sending}
          onClick={() => decide("deny")}
          className="h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Deny
        </button>
        {rules && (
          <button
            type="button"
            disabled={sending}
            title={`Don't ask again in this folder for: ${rules}`}
            onClick={() => decide("always")}
            className="flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border-strong px-2.5 text-xs font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="shrink-0">Always allow</span>
            <span className="truncate font-mono font-normal text-muted-foreground">
              {rules}
            </span>
          </button>
        )}
        <button
          ref={allowButton}
          type="button"
          disabled={sending}
          onClick={() => decide("allow")}
          className={PRIMARY}
        >
          Allow
        </button>
      </div>
    </div>
  );
}
