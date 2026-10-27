//! Tool permission rules in `~/.claude/settings.json` (its `permissions`
//! object), which every chat's agent loads, as Claude Code does.
//!
//! A rule names a tool (`Edit`) or a tool with a pattern (`Bash(git push:*)`)
//! and sits in one of three lists. When rules overlap, deny wins over ask and
//! ask over allow. Rules this module doesn't manage are left where they are.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::json_file::{read, write};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RuleBehavior {
    /// Runs without asking.
    Allow,
    /// Asks every time.
    Ask,
    /// Never runs.
    Deny,
}

impl RuleBehavior {
    const ALL: [RuleBehavior; 3] = [RuleBehavior::Allow, RuleBehavior::Ask, RuleBehavior::Deny];

    fn key(self) -> &'static str {
        match self {
            RuleBehavior::Allow => "allow",
            RuleBehavior::Ask => "ask",
            RuleBehavior::Deny => "deny",
        }
    }
}

/// The three lists, in the order the file holds them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PermissionRules {
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub deny: Vec<String>,
}

pub fn list(settings: &Path) -> Result<PermissionRules> {
    let root = read(settings)?;
    let Some(Value::Object(permissions)) = root.get("permissions") else { return Ok(PermissionRules::default()) };
    let rules = |behavior: RuleBehavior| {
        permissions
            .get(behavior.key())
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    };
    Ok(PermissionRules {
        allow: rules(RuleBehavior::Allow),
        ask: rules(RuleBehavior::Ask),
        deny: rules(RuleBehavior::Deny),
    })
}

/// Takes `rules` out of every list, then adds them to `behavior`'s; `None`
/// leaves them out, so the agent's default applies again.
pub fn set(settings: &Path, rules: &[String], behavior: Option<RuleBehavior>) -> Result<PermissionRules> {
    if rules.is_empty() || rules.iter().any(|r| r.trim().is_empty()) {
        return Err(Error::Invalid("A permission rule can't be empty".into()));
    }
    let mut root = read(settings)?;
    if behavior.is_none() && !root.contains_key("permissions") {
        return list(settings);
    }
    let permissions = root.entry("permissions").or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(permissions) = permissions else {
        return Err(Error::Invalid(format!("permissions in {} isn't an object", settings.display())));
    };

    for other in RuleBehavior::ALL {
        match permissions.get_mut(other.key()) {
            Some(Value::Array(list)) => list.retain(|r| !r.as_str().is_some_and(|r| rules.iter().any(|x| x == r))),
            Some(_) => {
                return Err(Error::Invalid(format!(
                    "permissions.{} in {} isn't a list",
                    other.key(),
                    settings.display()
                )));
            }
            None => {}
        }
    }
    if let Some(behavior) = behavior {
        let list = permissions.entry(behavior.key()).or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(list) = list {
            list.extend(rules.iter().map(|r| Value::String(r.clone())));
        }
    }

    write(settings, &root)?;
    list(settings)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rules(list: &[&str]) -> Vec<String> {
        list.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn moves_rules_between_lists_keeping_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"model": "opus", "permissions": {"allow": ["Bash(npm test:*)", "Edit"], "defaultMode": "default"}}"#,
        )
        .unwrap();

        let now = set(&path, &rules(&["Edit"]), Some(RuleBehavior::Deny)).unwrap();
        assert_eq!(now, PermissionRules { allow: rules(&["Bash(npm test:*)"]), ask: vec![], deny: rules(&["Edit"]) });

        let now = set(&path, &rules(&["Bash(git push:*)", "Bash(git commit:*)"]), Some(RuleBehavior::Ask)).unwrap();
        assert_eq!(now.ask, ["Bash(git push:*)", "Bash(git commit:*)"]);

        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["model"], "opus");
        assert_eq!(saved["permissions"]["defaultMode"], "default");
        let keys: Vec<_> = saved.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["model", "permissions"]);
    }

    #[test]
    fn none_returns_a_rule_to_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        set(&path, &rules(&["Write"]), Some(RuleBehavior::Allow)).unwrap();
        let now = set(&path, &rules(&["Write"]), None).unwrap();
        assert_eq!(now, PermissionRules::default());
    }

    #[test]
    fn a_missing_file_has_no_rules_and_a_reset_does_not_create_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude/settings.json");
        assert_eq!(list(&path).unwrap(), PermissionRules::default());
        set(&path, &rules(&["Bash"]), None).unwrap();
        assert!(!path.exists());
        set(&path, &rules(&["Bash"]), Some(RuleBehavior::Ask)).unwrap();
        assert_eq!(list(&path).unwrap().ask, ["Bash"]);
    }

    #[test]
    fn refuses_empty_rules_and_malformed_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(set(&path, &[], Some(RuleBehavior::Allow)).is_err());
        assert!(set(&path, &rules(&[" "]), Some(RuleBehavior::Allow)).is_err());

        std::fs::write(&path, json!({"permissions": {"deny": "Bash"}}).to_string()).unwrap();
        assert!(set(&path, &rules(&["Bash"]), Some(RuleBehavior::Allow)).is_err());

        std::fs::write(&path, "{ not json").unwrap();
        assert!(set(&path, &rules(&["Bash"]), Some(RuleBehavior::Allow)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
