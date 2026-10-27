use std::time::Duration;

use agent_protocol::{AgentEvent, AgentMode, AgentRequest};
use tokio_util::sync::CancellationToken;

use crate::RunOutcome;

/// Picks a Markdown template from keywords in the latest user message and
/// streams it a few words at a time.
#[derive(Debug, Clone)]
pub struct MockAgent {
    /// Scales every delay; tests use zero.
    pace: f64,
}

impl Default for MockAgent {
    fn default() -> Self {
        Self { pace: 1.0 }
    }
}

impl MockAgent {
    /// A mock that streams without pauses.
    pub fn instant() -> Self {
        Self { pace: 0.0 }
    }

    /// Streams a reply through `emit`, ending with `finish` or, once `cancel`
    /// fires, `stopped`.
    pub async fn run(
        &self,
        request: &AgentRequest,
        cancel: &CancellationToken,
        mut emit: impl FnMut(AgentEvent),
    ) -> RunOutcome {
        let reply = compose_reply(request);

        if !self.pause(450, cancel).await {
            emit(AgentEvent::Stopped);
            return RunOutcome::Stopped;
        }
        for chunk in chunk_text(&reply) {
            if cancel.is_cancelled() {
                emit(AgentEvent::Stopped);
                return RunOutcome::Stopped;
            }
            let delay = chunk_delay(&chunk);
            emit(AgentEvent::TextDelta { delta: chunk });
            if !self.pause(delay, cancel).await {
                emit(AgentEvent::Stopped);
                return RunOutcome::Stopped;
            }
        }
        emit(AgentEvent::Finish);
        RunOutcome::Finished
    }

    /// Sleeps for `ms` (scaled); returns false if cancelled first.
    async fn pause(&self, ms: u64, cancel: &CancellationToken) -> bool {
        let duration = Duration::from_millis((ms as f64 * self.pace) as u64);
        tokio::select! {
            _ = cancel.cancelled() => false,
            _ = tokio::time::sleep(duration) => true,
        }
    }
}

/// Splits text into runs of one to three words, keeping whitespace intact.
fn chunk_text(text: &str) -> Vec<String> {
    let mut tokens: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut in_word = false;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if in_word {
                tokens.push(&text[start..i]);
                start = i;
                in_word = false;
            }
        } else {
            in_word = true;
        }
    }
    if start < text.len() {
        tokens.push(&text[start..]);
    }

    let mut chunks = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let size = 1 + i % 3;
        let end = (i + size).min(tokens.len());
        chunks.push(tokens[i..end].concat());
        i = end;
    }
    chunks
}

fn chunk_delay(chunk: &str) -> u64 {
    let sentence_end = chunk.trim_end().ends_with(['.', '!', '?', ':']);
    18 + (chunk.len() as u64 % 5) * 7 + if sentence_end { 60 } else { 0 }
}

fn quote(prompt: &str) -> String {
    let one_line = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 90 {
        let cut: String = one_line.chars().take(87).collect();
        format!("{}…", cut.trim_end())
    } else {
        one_line
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Topic {
    Code,
    Plan,
    Review,
    Explain,
    General,
}

fn detect_topic(prompt: &str) -> Topic {
    let lower = prompt.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));

    if has(&["code", "function", "bug", "error", "typescript", "rust", "python", "api", "compile", "test", "refactor", "fix"]) {
        Topic::Code
    } else if has(&["plan", "project", "roadmap", "milestone", "steps", "feature"]) {
        Topic::Plan
    } else if has(&["review", "critique", "feedback", "idea", "evaluate"]) {
        Topic::Review
    } else if has(&["explain", "what", "how", "why", "understand"]) {
        Topic::Explain
    } else {
        Topic::General
    }
}

fn compose_reply(request: &AgentRequest) -> String {
    let prompt = request.prompt();
    let quoted = match quote(prompt) {
        q if q.is_empty() => "your message".to_owned(),
        q => q,
    };
    let place = match &request.workspace_name {
        Some(name) => format!(" in `{name}`"),
        None => String::new(),
    };
    let opener = match request.settings.mode {
        AgentMode::Agent => format!("Here's how I'd tackle **“{quoted}”**{place}."),
        AgentMode::Ask => format!("Good question: **“{quoted}”**."),
        AgentMode::Plan => format!("Here's a plan for **“{quoted}”**{place}, for you to review before anything changes."),
    };
    let note = "_This reply comes from the offline mock agent. Pick a Claude model for real answers._";
    format!("{opener}\n\n{}\n\n{note}", body(detect_topic(prompt)))
}

fn body(topic: Topic) -> &'static str {
    match topic {
        Topic::Code => CODE,
        Topic::Plan => PLAN,
        Topic::Review => REVIEW,
        Topic::Explain => EXPLAIN,
        Topic::General => GENERAL,
    }
}

const CODE: &str = r#"Start by pinning the problem down with the smallest example that still shows it. A small, well-typed helper is easier to reason about than a large inline block:

```rust
use std::time::Duration;

pub async fn with_retry<T, E, F, Fut>(mut task: F, attempts: u32) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut last = None;
    for i in 0..attempts {
        match task().await {
            Ok(value) => return Ok(value),
            Err(error) => last = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(100 * 2u64.pow(i))).await;
    }
    Err(last.expect("attempts > 0"))
}
```

Worth checking next:

- **Inputs**: are values validated at the boundary, or only assumed?
- **Failure paths**: does every error either recover or carry context upward?
- **Tests**: can you reproduce the issue in a test before changing anything?"#;

const PLAN: &str = r#"A plan is most useful when it makes the next action obvious:

1. **Define the outcome.** One sentence describing what "done" looks like.
2. **Test the riskiest assumption first.** Cheaply, before building around it.
3. **Sequence the rest.** Order tasks so each one unblocks the next.

| Phase | Focus | Typical length |
| --- | --- | --- |
| Discovery | Goals, constraints, risks | 1 week |
| Build | Smallest useful version | 2–4 weeks |
| Review | Feedback and iteration | 1 week |

> Keep the plan short enough that you will actually reread it."#;

const REVIEW: &str = r#"Here's a quick structured read:

**What works**

- The core idea is clear and easy to explain.
- The scope is small enough to ship and learn from.

**What to pressure-test**

- Who is the first user, and what do they do today instead?
- Which assumption, if wrong, makes the rest irrelevant?

**Suggested next step:** write the one-paragraph pitch and show it to two people who'd use it."#;

const EXPLAIN: &str = r#"The simplest way in is an analogy, then the precise version.

**The analogy.** Think of a library: you don't memorise every book, you learn how the catalogue works so you can find what you need.

**The precise version.** Underneath there are usually three ideas:

1. A *representation* of the information.
2. A *rule* for finding or changing it.
3. A *cost* trade-off between the two.

Once those three are clear, most of the details fall into place."#;

const GENERAL: &str = r#"Happy to help. To give you something useful, it helps to know:

- **The goal**: what should be true when this is done?
- **The constraints**: time, tools, or anything already decided.
- **The current state**: what exists today, and what's getting in the way.

Share any of those and I'll get more specific."#;

#[cfg(test)]
mod tests {
    use agent_protocol::{MessageRole, SessionSettings};

    use super::*;

    fn request(text: &str) -> AgentRequest {
        AgentRequest {
            session_id: "s".into(),
            messages: vec![(MessageRole::User, text.into())],
            settings: SessionSettings::default(),
            cwd: None,
            workspace_name: Some("elaris".into()),
            resume: None,
            allowed_tools: Vec::new(),
            images: Vec::new(),
        }
    }

    #[test]
    fn chunks_reassemble_to_the_original_text() {
        let text = "Hello  there,\n\nthis is\ta test.  ";
        assert_eq!(chunk_text(text).concat(), text);
    }

    #[test]
    fn picks_topic_from_keywords() {
        assert_eq!(detect_topic("Fix this bug please"), Topic::Code);
        assert_eq!(detect_topic("Make a roadmap"), Topic::Plan);
        assert_eq!(detect_topic("hello"), Topic::General);
    }

    #[tokio::test]
    async fn streams_the_whole_reply_then_finishes() {
        let mut events = Vec::new();
        let request = request("fix the bug");
        let cancel = CancellationToken::new();
        let outcome = MockAgent::instant().run(&request, &cancel, |e| events.push(e)).await;

        assert_eq!(outcome, RunOutcome::Finished);
        assert_eq!(events.last(), Some(&AgentEvent::Finish));
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::TextDelta { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("“fix the bug”"));
        assert!(text.contains("`elaris`"));
    }

    #[tokio::test]
    async fn stops_promptly_when_cancelled() {
        let cancel = CancellationToken::new();
        let mut events = Vec::new();
        let agent = MockAgent::default();
        let request = request("hi");
        let run = agent.run(&request, &cancel, |e| {
            if matches!(e, AgentEvent::TextDelta { .. }) {
                cancel.cancel();
            }
            events.push(e);
        });
        let outcome = tokio::time::timeout(Duration::from_secs(2), run).await.unwrap();

        assert_eq!(outcome, RunOutcome::Stopped);
        assert_eq!(events.len(), 2);
        assert_eq!(events.last(), Some(&AgentEvent::Stopped));
    }
}
