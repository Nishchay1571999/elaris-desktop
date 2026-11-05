//! Cutting a log down to what the agent asked for: matching lines only, each
//! distinct message once (with how often it repeated), the most recent last.

use std::collections::HashMap;

use regex::Regex;

use crate::ui::clip;

const LINE_MAX: usize = 300;

/// The last `lines` distinct messages of `raw` that match `grep`. Lines are
/// compared without their first two words (the date and time), and a repeated
/// one is shown where it last appeared, with a `(×N)` count.
pub fn digest(raw: &str, grep: Option<&Regex>, lines: usize) -> String {
    // Message → (where it was last seen, its last line, how often).
    let mut seen: HashMap<&str, (usize, &str, usize)> = HashMap::new();
    let mut matched = 0;
    for line in raw.lines().map(str::trim_end) {
        if line.is_empty() || is_banner(line) || grep.is_some_and(|re| !re.is_match(line)) {
            continue;
        }
        matched += 1;
        let entry = seen.entry(message_of(line)).or_insert((0, line, 0));
        *entry = (matched, line, entry.2 + 1);
    }
    let mut order: Vec<_> = seen.into_values().collect();
    order.sort_unstable_by_key(|(last, _, _)| *last);
    let order: Vec<(&str, usize)> = order.into_iter().map(|(_, line, count)| (line, count)).collect();
    if order.is_empty() {
        return match grep {
            Some(re) => format!("No log lines match /{re}/."),
            None => "The log is empty.".into(),
        };
    }
    let shown = order.len().min(lines);
    let mut out = vec![format!(
        "{matched} matching lines, {} distinct; the last {shown}:",
        order.len()
    )];
    for (line, count) in &order[order.len() - shown..] {
        let mut text = clip(line.trim_start(), LINE_MAX);
        if *count > 1 {
            text.push_str(&format!(" (×{count})"));
        }
        out.push(text);
    }
    out.join("\n")
}

/// A line without its leading date and time.
fn message_of(line: &str) -> &str {
    let mut rest = line;
    for _ in 0..2 {
        rest = rest.trim_start();
        match rest.find(char::is_whitespace) {
            Some(i) => rest = &rest[i..],
            None => return rest,
        }
    }
    rest.trim_start()
}

/// Headers the log tools print around the lines.
fn is_banner(line: &str) -> bool {
    line.starts_with("--------- beginning of") || line.starts_with("Timestamp ") || line.starts_with("Filtering the log data")
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "--------- beginning of main
10-29 14:44:26.884 I/ReactNativeJS( 6370): Reachability true
10-29 14:44:27.378 W/ReactNativeJS( 6370): Layout children must be of type Screen
10-29 14:44:27.752 I/ReactNativeJS( 6370): [CleverTap] listener added
10-29 14:44:28.604 W/ReactNativeJS( 6370): Layout children must be of type Screen
10-29 14:44:29.256 I/ReactNativeJS( 6370): Reachability true
10-29 14:44:29.522 W/ReactNativeJS( 6370): Layout children must be of type Screen";

    #[test]
    fn repeats_collapse_to_their_last_place() {
        assert_eq!(
            digest(LOG, None, 10),
            "6 matching lines, 3 distinct; the last 3:
10-29 14:44:27.752 I/ReactNativeJS( 6370): [CleverTap] listener added
10-29 14:44:29.256 I/ReactNativeJS( 6370): Reachability true (×2)
10-29 14:44:29.522 W/ReactNativeJS( 6370): Layout children must be of type Screen (×3)"
        );
    }

    #[test]
    fn grep_and_line_limits_apply() {
        let re = Regex::new("(?i)clevertap|reach").unwrap();
        assert_eq!(
            digest(LOG, Some(&re), 1),
            "3 matching lines, 2 distinct; the last 1:
10-29 14:44:29.256 I/ReactNativeJS( 6370): Reachability true (×2)"
        );
        let none = Regex::new("nope").unwrap();
        assert_eq!(digest(LOG, Some(&none), 5), "No log lines match /nope/.");
    }
}
