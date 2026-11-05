//! The screen as text: Android's uiautomator XML and AXe's accessibility JSON
//! become one short line per element the user can see or touch. A full dump
//! is tens of kilobytes of layout wrappers; the list is usually under 2 KB.
//!
//! A tappable element takes the text of the plain labels inside it ("Call
//! Rahul · 2m ago"), and those labels aren't listed again.

use quick_xml::XmlVersion;
use quick_xml::events::{BytesStart, Event};
use serde_json::Value;

use crate::{Error, Result};

/// Longest label shown for one element.
const LABEL_MAX: usize = 100;
/// Most inner labels joined into a tappable element's label.
const INNER_LABELS: usize = 4;
/// Longer ids are left out of the list.
const ID_MAX: usize = 40;

/// One element on screen. Coordinates are Android pixels or iOS points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Element {
    pub role: String,
    pub label: String,
    pub id: String,
    pub bounds: (i32, i32, i32, i32),
    pub flags: Vec<&'static str>,
}

impl Element {
    pub fn center(&self) -> (i32, i32) {
        let (x1, y1, x2, y2) = self.bounds;
        ((x1 + x2) / 2, (y1 + y2) / 2)
    }

    pub fn is_tappable(&self) -> bool {
        self.role != "Text" && self.role != "Image" && self.role != "Scroll"
    }

    /// Whether `query` names this element: its id, its label, or one part of a joined label.
    pub fn matches(&self, query: &str, exact: bool) -> bool {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return false;
        }
        let label = self.label.to_lowercase();
        if exact {
            label == query || label.split(" · ").any(|part| part == query)
        } else {
            label.contains(&query)
        }
    }

    fn line(&self, n: usize) -> String {
        let (x, y) = self.center();
        let mut line = format!("[{n}] {}", self.role);
        if !self.label.is_empty() {
            line.push_str(&format!(" {:?}", self.label));
        }
        // Generated ids (`row-3f2a…uuid`) cost tokens and nobody types them;
        // the element's number or label does the job.
        if !self.id.is_empty() && self.id.len() <= ID_MAX {
            line.push_str(&format!(" #{}", self.id));
        }
        line.push_str(&format!(" @{x},{y}"));
        for flag in &self.flags {
            line.push(' ');
            line.push_str(flag);
        }
        line
    }
}

/// What a dump says about the screen.
#[derive(Debug, Clone, Default)]
pub struct Screen {
    pub elements: Vec<Element>,
    pub width: i32,
    pub height: i32,
}

impl Screen {
    /// Elements whose label or id matches `query`, best first: exact label or
    /// id, then containing it; tappable before plain text.
    pub fn find(&self, query: &str) -> Vec<(usize, &Element)> {
        let mut found: Vec<_> = self
            .elements
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let rank = if e.id.eq_ignore_ascii_case(query.trim()) || e.matches(query, true) {
                    0
                } else if e.matches(query, false) {
                    2
                } else {
                    return None;
                };
                Some((rank + usize::from(!e.is_tappable()), i, e))
            })
            .collect();
        found.sort_by_key(|(rank, i, _)| (*rank, *i));
        found.into_iter().map(|(_, i, e)| (i, e)).collect()
    }

    pub fn has_text(&self, query: &str) -> bool {
        self.elements.iter().any(|e| e.matches(query, false) || e.id.eq_ignore_ascii_case(query.trim()))
    }

    /// The numbered list, cut to `max` lines.
    pub fn listing(&self, max: usize) -> String {
        let mut out: Vec<String> = self.elements.iter().take(max).enumerate().map(|(i, e)| e.line(i + 1)).collect();
        if self.elements.len() > max {
            out.push(format!("… {} more; pass maxElements to see them.", self.elements.len() - max));
        }
        if out.is_empty() {
            out.push("(Nothing readable on screen. It may still be loading, or be drawn without accessibility info; try again or ask for an image.)".into());
        }
        out.join("\n")
    }
}

/// A node of either tree, before it's flattened.
#[derive(Debug, Default)]
struct Node {
    role: String,
    label: String,
    id: String,
    bounds: (i32, i32, i32, i32),
    /// Taps, toggles or takes text.
    interactive: bool,
    scrollable: bool,
    flags: Vec<&'static str>,
    children: Vec<usize>,
}

/// Parses `uiautomator dump` output.
pub fn parse_android(xml: &str) -> Result<Screen> {
    let start = xml.find("<hierarchy").ok_or_else(|| Error::Failed(format!("uiautomator returned no screen: {}", clip(xml.trim(), 200))))?;
    let end = xml.rfind("</hierarchy>").map(|i| i + "</hierarchy>".len()).unwrap_or(xml.len());
    let mut reader = quick_xml::Reader::from_str(&xml[start..end]);
    let mut nodes: Vec<Node> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == "node" => {
                let i = push_android(&mut nodes, &stack, &e);
                stack.push(i);
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "node" => {
                push_android(&mut nodes, &stack, &e);
            }
            Ok(Event::End(e)) if e.name().as_ref() == "node" => {
                stack.pop();
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(Error::Failed(format!("Couldn't read uiautomator's dump: {e}"))),
        }
    }
    let (width, height) = nodes.first().map(|n| (n.bounds.2, n.bounds.3)).unwrap_or_default();
    Ok(Screen { elements: flatten(&nodes, width, height), width, height })
}

fn push_android(nodes: &mut Vec<Node>, stack: &[usize], e: &BytesStart) -> usize {
    let mut a = std::collections::HashMap::new();
    for attr in e.attributes().flatten() {
        let key = attr.key.as_ref().to_string();
        let value = attr.normalized_value(XmlVersion::Implicit1_0).map(|v| v.into_owned()).unwrap_or_default();
        a.insert(key, value);
    }
    let get = |k: &str| a.get(k).map(String::as_str).unwrap_or("");
    let yes = |k: &str| get(k) == "true";
    let class = get("class").rsplit('.').next().unwrap_or("").to_string();
    let clickable = yes("clickable") || yes("long-clickable");
    let checkable = yes("checkable");
    let editable = class.contains("EditText") || class.contains("AutoCompleteTextView");
    let role = match class.as_str() {
        _ if editable => "Field",
        c if c.contains("Switch") || c.contains("ToggleButton") => "Switch",
        c if c.contains("CheckBox") => "Checkbox",
        c if c.contains("RadioButton") => "Radio",
        _ if clickable || checkable => "Button",
        c if c.contains("ImageView") => "Image",
        _ if yes("scrollable") => "Scroll",
        _ => "Text",
    };
    let mut label = first_nonempty(&[get("text"), get("content-desc")]).to_string();
    if editable && label.is_empty() {
        label = get("hint").to_string();
    }
    if yes("password") && !label.is_empty() {
        label = "••••".into();
    }
    let mut flags = Vec::new();
    if checkable {
        flags.push(if yes("checked") { "on" } else { "off" });
    }
    if yes("selected") {
        flags.push("selected");
    }
    if yes("focused") && editable {
        flags.push("focused");
    }
    if !yes("enabled") && (clickable || editable) {
        flags.push("disabled");
    }
    let id = get("resource-id");
    let id = id.split_once(":id/").map(|(_, rest)| rest).unwrap_or(id).to_string();
    let node = Node {
        role: role.into(),
        label: tidy(&label),
        id,
        bounds: parse_bounds(get("bounds")),
        interactive: clickable || checkable || editable,
        scrollable: yes("scrollable"),
        flags,
        children: Vec::new(),
    };
    let i = nodes.len();
    nodes.push(node);
    if let Some(&parent) = stack.last() {
        nodes[parent].children.push(i);
    }
    i
}

/// `[0,63][1080,2337]` → (0, 63, 1080, 2337).
fn parse_bounds(s: &str) -> (i32, i32, i32, i32) {
    let n: Vec<i32> = s.split(|c: char| !c.is_ascii_digit() && c != '-').filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
    match n.as_slice() {
        [x1, y1, x2, y2] => (*x1, *y1, *x2, *y2),
        _ => (0, 0, 0, 0),
    }
}

/// Parses `axe describe-ui` output: one JSON tree (or a list of them) of
/// accessibility elements with `type`, `AXLabel`, `AXValue`, `AXUniqueId` and
/// a `frame` in points.
pub fn parse_ios(json: &str) -> Result<Screen> {
    let start = json.find(['[', '{']).ok_or_else(|| Error::Failed(format!("AXe returned no screen: {}", clip(json.trim(), 200))))?;
    let value: Value = serde_json::from_str(&json[start..]).map_err(|e| Error::Failed(format!("Couldn't read AXe's output: {e}")))?;
    let mut nodes = Vec::new();
    let roots: Vec<&Value> = match &value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut size = (0, 0);
    for root in roots {
        push_ios(&mut nodes, None, root, &mut size);
    }
    Ok(Screen { elements: flatten(&nodes, size.0, size.1), width: size.0, height: size.1 })
}

fn push_ios(nodes: &mut Vec<Node>, parent: Option<usize>, v: &Value, size: &mut (i32, i32)) {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let kind = first_nonempty(&[&s("type"), s("role").trim_start_matches("AX")]).to_string();
    let bounds = ios_frame(v);
    if kind == "Application" || (parent.is_none() && size.0 == 0) {
        *size = (bounds.2, bounds.3);
    }
    let label = first_nonempty(&[&s("AXLabel"), &s("title")]).to_string();
    let value = match v.get("AXValue") {
        Some(Value::String(t)) => t.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let (role, interactive) = match kind.as_str() {
        "Button" | "Link" | "Cell" | "Tab" | "MenuItem" | "Key" | "Incrementor" | "Stepper" | "SegmentedControl" => ("Button", true),
        "TextField" | "SecureTextField" | "SearchField" | "TextView" => ("Field", true),
        "Switch" | "Toggle" => ("Switch", true),
        "Slider" | "Picker" | "PickerWheel" => ("Slider", true),
        "Image" => ("Image", false),
        "ScrollView" | "Table" | "CollectionView" => ("Scroll", false),
        _ => ("Text", false),
    };
    let mut flags = Vec::new();
    let mut shown = label.clone();
    match role {
        "Switch" => flags.push(if value == "1" { "on" } else { "off" }),
        "Field" if kind == "SecureTextField" => {
            if !value.is_empty() {
                flags.push("filled");
            }
        }
        _ if !value.is_empty() && value != label => {
            shown = if label.is_empty() { value.clone() } else { format!("{label}: {value}") };
        }
        _ => {}
    }
    if !enabled && interactive {
        flags.push("disabled");
    }
    let skip = kind == "Application";
    let index = if skip {
        parent
    } else {
        let i = nodes.len();
        nodes.push(Node {
            role: role.into(),
            label: tidy(&shown),
            id: s("AXUniqueId"),
            bounds,
            interactive,
            scrollable: role == "Scroll",
            flags,
            children: Vec::new(),
        });
        if let Some(p) = parent {
            nodes[p].children.push(i);
        }
        Some(i)
    };
    if let Some(Value::Array(children)) = v.get("children") {
        for child in children {
            push_ios(nodes, index, child, size);
        }
    }
}

/// An AXe `frame` object, or the older `AXFrame` string `{{x, y}, {w, h}}`, as edges.
fn ios_frame(v: &Value) -> (i32, i32, i32, i32) {
    let (x, y, w, h) = if let Some(f) = v.get("frame") {
        let n = |k: &str| f.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        (n("x"), n("y"), n("width"), n("height"))
    } else {
        let s = v.get("AXFrame").and_then(Value::as_str).unwrap_or("");
        let n: Vec<f64> = s.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).filter_map(|p| p.parse().ok()).collect();
        match n.as_slice() {
            [x, y, w, h] => (*x, *y, *w, *h),
            _ => (0.0, 0.0, 0.0, 0.0),
        }
    };
    (x.round() as i32, y.round() as i32, (x + w).round() as i32, (y + h).round() as i32)
}

/// The nodes worth listing, in reading order.
fn flatten(nodes: &[Node], width: i32, height: i32) -> Vec<Element> {
    let visible = |n: &Node| {
        let (x1, y1, x2, y2) = n.bounds;
        x2 > x1 && y2 > y1 && x2 > 0 && y2 > 0 && (width == 0 || x1 < width) && (height == 0 || y1 < height)
    };
    let mut consumed = vec![false; nodes.len()];
    let mut out: Vec<Element> = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        if consumed[i] || !visible(node) {
            continue;
        }
        let label = if node.interactive {
            // The labels inside it, down to the next tappable element (listed on its own).
            let mut labels: Vec<String> = Vec::new();
            if !node.label.is_empty() {
                labels.push(node.label.clone());
            }
            let mut todo: Vec<usize> = node.children.iter().rev().copied().collect();
            while let Some(c) = todo.pop() {
                let child = &nodes[c];
                if child.interactive || child.scrollable {
                    // iOS cells nest a button saying the same as the cell.
                    if child.interactive && labels.contains(&child.label) {
                        consumed[c] = true;
                    }
                    continue;
                }
                consumed[c] = true;
                // React Native often repeats the inner texts in the row's own label.
                if visible(child) && !child.label.is_empty() && !labels.iter().any(|l| l.contains(&child.label)) {
                    labels.push(child.label.clone());
                }
                todo.extend(child.children.iter().rev());
            }
            labels.truncate(INNER_LABELS);
            labels.join(" · ")
        } else if node.scrollable || !node.label.is_empty() {
            node.label.clone()
        } else {
            continue;
        };
        let element = Element {
            role: node.role.clone(),
            label: clip(&label, LABEL_MAX),
            id: node.id.clone(),
            bounds: node.bounds,
            flags: node.flags.clone(),
        };
        // Wrappers and their only child, or an overlay copy of a header, say
        // the same thing at the same place.
        if out.iter().any(|e| e.label == element.label && e.center() == element.center() && e.role == element.role) {
            continue;
        }
        out.push(element);
    }
    // iOS lists a cell's texts beside the cell rather than inside it: drop
    // text a tappable element around it already says.
    let covered = |t: &Element| {
        t.role == "Text"
            && !t.label.is_empty()
            && out.iter().any(|o| {
                let (x, y) = t.center();
                let (x1, y1, x2, y2) = o.bounds;
                o.is_tappable() && o.label.contains(&t.label) && (x1..=x2).contains(&x) && (y1..=y2).contains(&y)
            })
    };
    let drop: Vec<bool> = out.iter().map(covered).collect();
    out.into_iter().zip(drop).filter(|(_, d)| !d).map(|(e, _)| e).collect()
}

/// A label as one line, without icon-font glyphs (Unicode private use, e.g.
/// `\u{f130}` chevrons), which mean nothing as text and cost tokens.
fn tidy(label: &str) -> String {
    let text: String = label.chars().filter(|c| !matches!(*c as u32, 0xE000..=0xF8FF | 0xF0000..=0x10FFFF)).collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.trim_matches(|c: char| c == ',' || c == '·' || c.is_whitespace()).replace(", ,", ",").to_string()
}

fn first_nonempty<'a>(options: &[&'a str]) -> &'a str {
    options.iter().copied().find(|s| !s.trim().is_empty()).unwrap_or("")
}

pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANDROID: &str = r#"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
  <node index="0" text="" resource-id="com.app:id/back" class="android.widget.ImageButton" content-desc="Back" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,100][120,220]" />
  <node index="1" text="Calls" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[140,120][400,200]" />
  <node index="2" text="" resource-id="" class="android.widget.ScrollView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="true" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,240][1080,2200]">
    <node index="0" text="" resource-id="" class="android.view.ViewGroup" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,240][1080,420]">
      <node index="0" text="Rahul" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,260][400,320]" />
      <node index="1" text="2m ago" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,330][400,390]" />
    </node>
    <node index="1" text="" resource-id="" class="android.widget.EditText" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" hint="Search" bounds="[0,440][1080,560]" />
    <node index="2" text="" resource-id="" class="android.widget.Switch" content-desc="Robin's voice" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,580][1080,700]" />
    <node index="3" text="Hidden" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" />
  </node>
</node>
</hierarchy>UI hierchary dumped to: /dev/tty"#;

    #[test]
    fn android_dump_becomes_a_short_list() {
        let screen = parse_android(ANDROID).unwrap();
        assert_eq!((screen.width, screen.height), (1080, 2400));
        assert_eq!(
            screen.listing(100),
            [
                r##"[1] Button "Back" #back @60,160"##,
                r#"[2] Text "Calls" @270,160"#,
                "[3] Scroll @540,1220",
                r#"[4] Button "Rahul · 2m ago" @540,330"#,
                r#"[5] Field "Search" @540,500 focused"#,
                r#"[6] Switch "Robin's voice" @540,640 on"#,
            ]
            .join("\n")
        );
    }

    #[test]
    fn finds_by_text_preferring_tappable_exact_matches() {
        let screen = parse_android(ANDROID).unwrap();
        assert_eq!(screen.find("rahul").first().map(|(i, _)| *i), Some(3));
        assert_eq!(screen.find("back").first().map(|(i, _)| *i), Some(0));
        assert_eq!(screen.find("call").first().map(|(i, _)| *i), Some(1));
        assert!(screen.find("nothing here").is_empty());
        assert!(screen.has_text("2M AGO"));
    }

    #[test]
    fn long_lists_are_cut() {
        let screen = parse_android(ANDROID).unwrap();
        assert!(screen.listing(2).ends_with("… 4 more; pass maxElements to see them."));
    }

    #[test]
    fn icon_glyphs_are_dropped() {
        assert_eq!(tidy("Robin's Voice, Male, \u{f130}"), "Robin's Voice, Male");
        assert_eq!(tidy("\u{f1d6}"), "");
        assert_eq!(tidy("  Go   back "), "Go back");
    }

    #[test]
    fn no_hierarchy_is_an_error() {
        assert!(parse_android("ERROR: could not get idle state.").is_err());
    }

    #[test]
    fn ios_tree_becomes_a_short_list() {
        let json = r#"[{"type":"Application","AXLabel":"Robin","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
            {"type":"Button","AXLabel":"Back","AXUniqueId":"back","frame":{"x":0,"y":50,"width":60,"height":44},"children":[]},
            {"type":"StaticText","AXLabel":"Settings","frame":{"x":150,"y":60,"width":100,"height":24}},
            {"type":"Switch","AXLabel":"Notifications","AXValue":"1","frame":{"x":0,"y":120,"width":402,"height":44}},
            {"type":"TextField","AXLabel":"Name","AXValue":"Asha","frame":{"x":0,"y":180,"width":402,"height":44}},
            {"type":"Other","AXLabel":"","frame":{"x":0,"y":0,"width":402,"height":874}},
            {"type":"Button","AXLabel":"Offscreen","frame":{"x":0,"y":900,"width":40,"height":40}}
        ]}]"#;
        let screen = parse_ios(json).unwrap();
        assert_eq!((screen.width, screen.height), (402, 874));
        assert_eq!(
            screen.listing(100),
            [
                r##"[1] Button "Back" #back @30,72"##,
                r#"[2] Text "Settings" @200,72"#,
                r#"[3] Switch "Notifications" @201,142 on"#,
                r#"[4] Field "Name: Asha" @201,202"#,
            ]
            .join("\n")
        );
    }

    #[test]
    fn ios_cell_texts_fold_into_the_cell() {
        let json = r#"[{"type":"Application","frame":{"x":0,"y":0,"width":402,"height":874},"children":[
            {"type":"StaticText","AXLabel":"Name, iPhone","frame":{"x":0,"y":140,"width":402,"height":40}},
            {"type":"Button","AXLabel":"Name, iPhone","frame":{"x":0,"y":140,"width":402,"height":40}},
            {"type":"Button","AXLabel":"iOS Version, 26.2","frame":{"x":0,"y":190,"width":402,"height":44}},
            {"type":"StaticText","AXLabel":"iOS Version","frame":{"x":20,"y":200,"width":120,"height":24}},
            {"type":"StaticText","AXLabel":"26.2","frame":{"x":300,"y":200,"width":50,"height":24}},
            {"type":"StaticText","AXLabel":"About","frame":{"x":150,"y":70,"width":100,"height":30}}
        ]}]"#;
        assert_eq!(
            parse_ios(json).unwrap().listing(100),
            [r#"[1] Button "Name, iPhone" @201,160"#, r#"[2] Button "iOS Version, 26.2" @201,212"#, r#"[3] Text "About" @200,85"#].join("\n")
        );
    }

    #[test]
    fn old_axframe_strings_are_read() {
        let v: Value = serde_json::from_str(r#"{"AXFrame":"{{10, 20.5}, {100, 40}}"}"#).unwrap();
        assert_eq!(ios_frame(&v), (10, 21, 110, 61));
    }
}
