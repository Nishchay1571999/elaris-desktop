//! Key combinations as the agent writes them, e.g. `cmd+shift+t`, `return` or
//! `ctrl+c`: modifiers and one key, joined by `+`, in any case. Keys are macOS
//! virtual key codes, by position on a US keyboard.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub command: bool,
    pub shift: bool,
    pub control: bool,
    pub option: bool,
    pub function: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub key: u16,
    pub modifiers: Modifiers,
}

/// Virtual key codes from `HIToolbox/Events.h` (`kVK_*`).
pub const RETURN: u16 = 36;

const NAMED: &[(&str, u16)] = &[
    ("return", RETURN),
    ("enter", RETURN),
    ("tab", 48),
    ("space", 49),
    ("backspace", 51),
    ("delete", 51),
    ("escape", 53),
    ("esc", 53),
    ("forwarddelete", 117),
    ("home", 115),
    ("end", 119),
    ("pageup", 116),
    ("pagedown", 121),
    ("left", 123),
    ("right", 124),
    ("down", 125),
    ("up", 126),
    ("f1", 122),
    ("f2", 120),
    ("f3", 99),
    ("f4", 118),
    ("f5", 96),
    ("f6", 97),
    ("f7", 98),
    ("f8", 100),
    ("f9", 101),
    ("f10", 109),
    ("f11", 103),
    ("f12", 111),
];

/// Single characters, by their place on a US keyboard.
const CHARACTERS: &[(char, u16)] = &[
    ('a', 0), ('s', 1), ('d', 2), ('f', 3), ('h', 4), ('g', 5), ('z', 6), ('x', 7), ('c', 8), ('v', 9),
    ('b', 11), ('q', 12), ('w', 13), ('e', 14), ('r', 15), ('y', 16), ('t', 17), ('1', 18), ('2', 19),
    ('3', 20), ('4', 21), ('6', 22), ('5', 23), ('=', 24), ('9', 25), ('7', 26), ('-', 27), ('8', 28),
    ('0', 29), (']', 30), ('o', 31), ('u', 32), ('[', 33), ('i', 34), ('p', 35), ('l', 37), ('j', 38),
    ('\'', 39), ('k', 40), (';', 41), ('\\', 42), (',', 43), ('/', 44), ('n', 45), ('m', 46), ('.', 47),
    ('`', 50),
];

impl Combo {
    /// Reads `cmd+shift+t` and the like; the error says what wasn't understood.
    pub fn parse(text: &str) -> Result<Self, String> {
        let parts: Vec<String> = text.split('+').map(|p| p.trim().to_lowercase()).collect();
        let (key, mods) = parts.split_last().filter(|(key, _)| !key.is_empty()).ok_or_else(|| {
            format!("`{text}` has no key. Write keys like `return`, `cmd+c` or `cmd+shift+t`.")
        })?;

        let mut modifiers = Modifiers::default();
        for name in mods {
            let flag = match name.as_str() {
                "cmd" | "command" | "meta" | "super" => &mut modifiers.command,
                "shift" => &mut modifiers.shift,
                "ctrl" | "control" => &mut modifiers.control,
                "alt" | "opt" | "option" => &mut modifiers.option,
                "fn" => &mut modifiers.function,
                _ => return Err(format!("`{name}` isn't a modifier. Use cmd, shift, ctrl, option or fn.")),
            };
            *flag = true;
        }
        Ok(Self { key: key_code(key)?, modifiers })
    }
}

fn key_code(name: &str) -> Result<u16, String> {
    if let Some(&(_, code)) = NAMED.iter().find(|(n, _)| *n == name) {
        return Ok(code);
    }
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && let Some(&(_, code)) = CHARACTERS.iter().find(|(k, _)| *k == c)
    {
        return Ok(code);
    }
    Err(format!(
        "`{name}` isn't a key I know. Use a letter, digit or punctuation mark, or one of: {}. To type text, use `type`.",
        NAMED.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_modifiers_and_a_key() {
        let combo = Combo::parse("Cmd+Shift+T").unwrap();
        assert_eq!(combo.key, 17);
        assert_eq!(combo.modifiers, Modifiers { command: true, shift: true, ..Modifiers::default() });
    }

    #[test]
    fn reads_named_keys_and_punctuation() {
        assert_eq!(Combo::parse("return").unwrap().key, RETURN);
        assert_eq!(Combo::parse("ctrl + left").unwrap().key, 123);
        assert_eq!(Combo::parse("cmd+,").unwrap().key, 43);
        assert_eq!(Combo::parse("cmd+=").unwrap().key, 24);
    }

    #[test]
    fn says_what_it_didnt_understand() {
        assert!(Combo::parse("hyper+a").unwrap_err().contains("`hyper` isn't a modifier"));
        assert!(Combo::parse("cmd+launch").unwrap_err().contains("`launch` isn't a key"));
        assert!(Combo::parse("cmd+").unwrap_err().contains("has no key"));
    }
}
