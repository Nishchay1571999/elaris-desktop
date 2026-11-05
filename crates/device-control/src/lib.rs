//! Android emulators and iOS simulators for the agent's `device-control`
//! tool. It exists to make device work cheap in tokens:
//!
//! - the screen comes back as a numbered list of what's on it ([`ui`]), not
//!   a screenshot, unless an image is asked for;
//! - taps name an element by number or text, and a batch of steps runs in
//!   one call ([`Step`]);
//! - logs are the app's process only, filtered and de-duplicated ([`logs`]);
//! - app files and databases are read in place ([`data`]).
//!
//! Android goes through `adb` and `emulator`; iOS through `xcrun simctl`, plus
//! [AXe](https://github.com/cameroncooke/AXe) for the screen and touches.
//! [`DeviceControl`] remembers the current device, app and element list.

mod android;
mod data;
mod exec;
mod ios;
pub mod logs;
pub mod ui;

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;

pub use ui::{Element, Screen};

/// Screenshots are this wide; enough to see a layout, a fraction of the tokens.
pub const SCREENSHOT_WIDTH: u32 = 400;
/// Element lines listed when the agent doesn't say.
const MAX_ELEMENTS: usize = 100;
/// Log lines returned when the agent doesn't say.
const LOG_LINES: usize = 60;
/// How far back iOS logs go when the agent doesn't say.
const IOS_LOG_SECONDS: u64 = 300;
/// Gives the app time to react between steps.
const SETTLE: Duration = Duration::from_millis(350);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A tool this needs isn't installed; the message says how to get it.
    #[error("{0}")]
    Missing(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
    #[error("`{0}` took longer than {1} s and was stopped.")]
    Timeout(String, u64),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Android,
    Ios,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub platform: Platform,
    /// adb serial or simulator UDID; for an emulator that isn't running, its AVD name.
    pub id: String,
    pub name: String,
    pub booted: bool,
    /// iOS version, "emulator", or adb's state when it isn't "device".
    pub detail: String,
}

impl Device {
    fn line(&self) -> String {
        let platform = match self.platform {
            Platform::Android => "Android",
            Platform::Ios => "iOS",
        };
        let mut line = format!("{platform} · {}", self.name);
        if self.id != self.name {
            line.push_str(&format!(" · {}", self.id));
        }
        if !self.detail.is_empty() {
            line.push_str(&format!(" · {}", self.detail));
        }
        line
    }

    fn unit(&self) -> &'static str {
        match self.platform {
            Platform::Android => "px",
            Platform::Ios => "pt",
        }
    }

    fn named(&self, query: &str) -> bool {
        let q = query.trim().to_lowercase();
        self.id.to_lowercase() == q || self.name.to_lowercase() == q
    }

    fn dump(&self) -> Result<Screen> {
        match self.platform {
            Platform::Android => android::dump(self),
            Platform::Ios => ios::dump(self),
        }
    }

    fn tap(&self, (x, y): (i32, i32)) -> Result<()> {
        match self.platform {
            Platform::Android => android::tap(self, x, y),
            Platform::Ios => ios::tap(self, x, y),
        }
    }

    fn long_press(&self, (x, y): (i32, i32), ms: u64) -> Result<()> {
        match self.platform {
            Platform::Android => android::long_press(self, x, y, ms),
            Platform::Ios => ios::long_press(self, x, y, ms),
        }
    }

    fn swipe(&self, from: (i32, i32), to: (i32, i32), ms: u64) -> Result<()> {
        match self.platform {
            Platform::Android => android::swipe(self, from, to, ms),
            Platform::Ios => ios::swipe(self, from, to, ms),
        }
    }

    fn type_text(&self, text: &str) -> Result<()> {
        match self.platform {
            Platform::Android => android::type_text(self, text),
            Platform::Ios => ios::type_text(self, text),
        }
    }

    fn key(&self, key: &str) -> Result<()> {
        match self.platform {
            Platform::Android => android::key(self, key),
            Platform::Ios => ios::key(self, key),
        }
    }

    fn open_url(&self, url: &str) -> Result<()> {
        match self.platform {
            Platform::Android => android::open_url(self, url),
            Platform::Ios => ios::open_url(self, url),
        }
    }

    fn screenshot(&self) -> Result<Vec<u8>> {
        match self.platform {
            Platform::Android => android::screenshot(self, SCREENSHOT_WIDTH),
            Platform::Ios => ios::screenshot(self, SCREENSHOT_WIDTH),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppOp {
    List,
    Launch,
    Stop,
    Restart,
    Install,
    Uninstall,
    Clear,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataOp {
    Ls,
    Read,
    Sql,
}

/// What `act` shows once its steps have run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Observe {
    #[default]
    Elements,
    Image,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Verbose,
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Verbose => "verbose",
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// What a tap, long press or `type` acts on: an element number from the last
/// list, an element's text or id on the screen now, or a point.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub element: Option<usize>,
    pub text: Option<String>,
    pub id: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

/// One step of an `act` batch.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "do", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Step {
    Tap {
        #[serde(flatten)]
        target: Target,
    },
    LongPress {
        #[serde(flatten)]
        target: Target,
        ms: Option<u64>,
    },
    /// The finger moves in `direction`, or from one point to another.
    Swipe {
        direction: Option<Direction>,
        from_x: Option<i32>,
        from_y: Option<i32>,
        to_x: Option<i32>,
        to_y: Option<i32>,
        ms: Option<u64>,
    },
    /// The content moves to show what's further in `direction`, until `until_text` shows.
    Scroll {
        direction: Direction,
        until_text: Option<String>,
        max: Option<u32>,
    },
    Type {
        text: String,
        #[serde(default)]
        submit: bool,
    },
    Key {
        key: String,
    },
    Wait {
        ms: u64,
    },
    WaitFor {
        text: Option<String>,
        id: Option<String>,
        #[serde(default)]
        gone: bool,
        timeout_ms: Option<u64>,
    },
    OpenUrl {
        url: String,
    },
}

/// A call to the tool, as the sidecar sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Devices,
    Boot {
        name: String,
    },
    App {
        device: Option<String>,
        op: AppOp,
        app: Option<String>,
        path: Option<String>,
    },
    Screen {
        device: Option<String>,
        #[serde(default)]
        image: bool,
        max_elements: Option<usize>,
    },
    Act {
        device: Option<String>,
        steps: Vec<Step>,
        #[serde(default)]
        observe: Observe,
        max_elements: Option<usize>,
    },
    Logs {
        device: Option<String>,
        app: Option<String>,
        grep: Option<String>,
        since: Option<u64>,
        lines: Option<usize>,
        level: Option<Level>,
    },
    AppData {
        device: Option<String>,
        app: Option<String>,
        op: DataOp,
        path: Option<String>,
        query: Option<String>,
        grep: Option<String>,
    },
}

/// What a call answers the agent with.
#[derive(Debug, Default)]
pub struct Reply {
    pub text: String,
    /// A JPEG of the screen, [`SCREENSHOT_WIDTH`] pixels wide.
    pub image: Option<Vec<u8>>,
}

impl From<String> for Reply {
    fn from(text: String) -> Self {
        Self { text, image: None }
    }
}

#[derive(Default)]
struct State {
    /// The device calls go to when they don't name one.
    current: Option<Device>,
    /// The app last named on each device, by device id.
    apps: HashMap<String, String>,
    /// The element list last shown for each device, which `[n]` refers to.
    screens: HashMap<String, (Screen, String)>,
}

/// The tool: one per app, shared by every chat.
#[derive(Default)]
pub struct DeviceControl {
    state: Mutex<State>,
}

impl DeviceControl {
    pub fn handle(&self, request: Request) -> Result<Reply> {
        match request {
            Request::Devices => self.devices().map(Reply::from),
            Request::Boot { name } => self.boot(&name).map(Reply::from),
            Request::App { device, op, app, path } => self.app(device.as_deref(), op, app.as_deref(), path.as_deref()).map(Reply::from),
            Request::Screen { device, image, max_elements } => {
                let device = self.pick(device.as_deref())?;
                self.screen(&device, image, max_elements.unwrap_or(MAX_ELEMENTS))
            }
            Request::Act { device, steps, observe, max_elements } => {
                let device = self.pick(device.as_deref())?;
                self.act(&device, &steps, observe, max_elements.unwrap_or(MAX_ELEMENTS))
            }
            Request::Logs { device, app, grep, since, lines, level } => {
                let device = self.pick(device.as_deref())?;
                self.logs(&device, app.as_deref(), grep.as_deref(), since, lines, level).map(Reply::from)
            }
            Request::AppData { device, app, op, path, query, grep } => {
                let device = self.pick(device.as_deref())?;
                self.app_data(&device, app.as_deref(), op, path.as_deref(), query.as_deref(), grep.as_deref()).map(Reply::from)
            }
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every device on both platforms. A platform whose tools are missing is
    /// left out, unless both are.
    fn all_devices() -> Result<Vec<Device>> {
        let android = android::list();
        let ios = if cfg!(target_os = "macos") { ios::list() } else { Ok(Vec::new()) };
        match (android, ios) {
            (Ok(mut a), Ok(i)) => {
                a.extend(i);
                Ok(a)
            }
            (Ok(a), Err(_)) => Ok(a),
            (Err(_), Ok(i)) => Ok(i),
            (Err(a), Err(i)) => Err(Error::Missing(format!("{a}\n{i}"))),
        }
    }

    /// The device a call goes to: the one named, else the current one, else the only one running.
    fn pick(&self, query: Option<&str>) -> Result<Device> {
        if query.is_none() {
            if let Some(current) = self.state().current.clone() {
                return Ok(current);
            }
        }
        let all = Self::all_devices()?;
        let device = match query {
            Some(q) => {
                let lower = q.trim().to_lowercase();
                let mut found: Vec<&Device> = all.iter().filter(|d| d.named(q)).collect();
                if found.is_empty() {
                    found = all.iter().filter(|d| d.name.to_lowercase().contains(&lower)).collect();
                }
                found.sort_by_key(|d| !d.booted);
                let device = found.first().ok_or_else(|| Error::Invalid(format!("No device matches {q:?}. `devices` lists them.")))?;
                if !device.booted {
                    return Err(Error::Invalid(format!("{} isn't running. Start it with `boot`.", device.line())));
                }
                (*device).clone()
            }
            None => {
                let booted: Vec<&Device> = all.iter().filter(|d| d.booted).collect();
                match booted.as_slice() {
                    [one] => (*one).clone(),
                    [] => {
                        return Err(Error::Invalid(
                            "No emulator or simulator is running. `devices` lists them; start one with `boot`.".into(),
                        ));
                    }
                    many => {
                        let list: Vec<String> = many.iter().map(|d| format!("  {}", d.line())).collect();
                        return Err(Error::Invalid(format!("Several devices are running; name one with `device`:\n{}", list.join("\n"))));
                    }
                }
            }
        };
        self.state().current = Some(device.clone());
        Ok(device)
    }

    fn devices(&self) -> Result<String> {
        let all = Self::all_devices()?;
        let current = self.state().current.as_ref().map(|d| d.id.clone());
        let (running, idle): (Vec<&Device>, Vec<&Device>) = all.iter().partition(|d| d.booted);
        let mut out = vec!["Running:".to_string()];
        if running.is_empty() {
            out.push("  (none)".into());
        }
        for d in &running {
            let mark = if current.as_deref() == Some(d.id.as_str()) { "  ← current" } else { "" };
            out.push(format!("  {}{mark}", d.line()));
        }
        if !idle.is_empty() {
            out.push("Can be started with `boot`:".into());
            const SHOWN: usize = 15;
            for d in idle.iter().take(SHOWN) {
                out.push(format!("  {}", d.line()));
            }
            if idle.len() > SHOWN {
                out.push(format!("  … {} more", idle.len() - SHOWN));
            }
        }
        Ok(out.join("\n"))
    }

    fn boot(&self, name: &str) -> Result<String> {
        let all = Self::all_devices()?;
        let lower = name.trim().to_lowercase();
        let device = all
            .iter()
            .find(|d| d.named(name))
            .or_else(|| all.iter().find(|d| d.name.to_lowercase().contains(&lower)))
            .ok_or_else(|| Error::Invalid(format!("No emulator or simulator matches {name:?}. `devices` lists them.")))?
            .clone();
        if device.booted {
            self.state().current = Some(device.clone());
            return Ok(format!("{} is already running; it's now the current device.", device.line()));
        }
        let device = match device.platform {
            Platform::Android => android::boot(&device.name)?,
            Platform::Ios => {
                ios::boot(&device)?;
                Device { booted: true, ..device }
            }
        };
        let line = device.line();
        self.state().current = Some(device);
        Ok(format!("Started {line}; it's now the current device."))
    }

    /// The app a call is about: the one named, else the last one named on this device.
    fn app_for(&self, device: &Device, app: Option<&str>) -> Option<String> {
        let mut state = self.state();
        match app.map(str::trim).filter(|a| !a.is_empty()) {
            Some(app) => {
                state.apps.insert(device.id.clone(), app.to_string());
                Some(app.to_string())
            }
            None => state.apps.get(&device.id).cloned(),
        }
    }

    fn need_app(&self, device: &Device, app: Option<&str>) -> Result<String> {
        self.app_for(device, app).ok_or_else(|| {
            Error::Invalid("Name the app: its package (Android) or bundle id (iOS). `app` with action list shows them.".into())
        })
    }

    fn app(&self, device: Option<&str>, op: AppOp, app: Option<&str>, path: Option<&str>) -> Result<String> {
        let device = self.pick(device)?;
        let id = match op {
            AppOp::List | AppOp::Install => self.app_for(&device, app).unwrap_or_default(),
            _ => self.need_app(&device, app)?,
        };
        match device.platform {
            Platform::Android => android::app(&device, op, &id, path),
            Platform::Ios => ios::app(&device, op, &id, path),
        }
    }

    fn header(device: &Device, screen: &Screen) -> String {
        let mut header = device.line();
        if device.platform == Platform::Android {
            if let Some(activity) = android::foreground(device) {
                header.push_str(&format!(" · {activity}"));
            }
        }
        header.push_str(&format!(" · {}×{} {}", screen.width, screen.height, device.unit()));
        header
    }

    /// Remembers `screen` as the list `[n]` refers to; returns its listing.
    fn remember(&self, device: &Device, screen: Screen, max: usize) -> String {
        let listing = screen.listing(max);
        self.state().screens.insert(device.id.clone(), (screen, listing.clone()));
        listing
    }

    fn image_note(device: &Device, screen: &Screen) -> String {
        let scale = f64::from(screen.width.max(1)) / f64::from(SCREENSHOT_WIDTH);
        format!(
            "Screenshot attached, {SCREENSHOT_WIDTH} px wide: multiply its pixels by {scale:.2} for {} coordinates. Prefer tapping elements by number or text.",
            device.unit()
        )
    }

    fn screen(&self, device: &Device, image: bool, max: usize) -> Result<Reply> {
        let screen = device.dump()?;
        let header = Self::header(device, &screen);
        let count = screen.elements.len();
        let note = image.then(|| Self::image_note(device, &screen));
        let listing = self.remember(device, screen, max);
        let mut text = format!("{header}\n{count} elements; act on them by [n] or text, coordinates in {}:\n{listing}", device.unit());
        let mut reply = Reply::default();
        if let Some(note) = note {
            reply.image = Some(device.screenshot()?);
            text.push_str(&format!("\n{note}"));
        }
        reply.text = text;
        Ok(reply)
    }

    fn act(&self, device: &Device, steps: &[Step], observe: Observe, max: usize) -> Result<Reply> {
        if steps.is_empty() {
            return Err(Error::Invalid("Give at least one step.".into()));
        }
        let (listed, before) = match self.state().screens.get(&device.id) {
            Some((screen, listing)) => (Some(screen.clone()), Some(listing.clone())),
            None => (None, None),
        };
        let mut lines = Vec::new();
        for (i, step) in steps.iter().enumerate() {
            match self.step(device, step, listed.as_ref()) {
                Ok(done) => lines.push(format!("{}. {done}", i + 1)),
                Err(e) => {
                    lines.push(format!("{}. Failed: {e}", i + 1));
                    if i + 1 < steps.len() {
                        lines.push(format!("Stopped; steps {}–{} didn't run.", i + 2, steps.len()));
                    }
                    break;
                }
            }
        }
        let mut reply = Reply::default();
        if observe != Observe::None {
            sleep(SETTLE * 2);
            let screen = device.dump()?;
            let count = screen.elements.len();
            let note = (observe == Observe::Image).then(|| Self::image_note(device, &screen));
            let header = Self::header(device, &screen);
            let listing = self.remember(device, screen, max);
            if before.as_deref() == Some(listing.as_str()) && note.is_none() {
                lines.push(format!("Screen unchanged ({count} elements; the numbers still hold)."));
            } else {
                lines.push(format!("Now: {header}\n{count} elements:\n{listing}"));
            }
            if let Some(note) = note {
                reply.image = Some(device.screenshot()?);
                lines.push(note);
            }
        }
        reply.text = lines.join("\n");
        Ok(reply)
    }

    fn step(&self, device: &Device, step: &Step, listed: Option<&Screen>) -> Result<String> {
        let done = match step {
            Step::Tap { target } => {
                let (at, what) = locate(device, target, listed)?;
                device.tap(at)?;
                format!("Tapped {what}")
            }
            Step::LongPress { target, ms } => {
                let (at, what) = locate(device, target, listed)?;
                let ms = ms.unwrap_or(800).clamp(100, 10_000);
                device.long_press(at, ms)?;
                format!("Long-pressed {what} for {ms} ms")
            }
            Step::Swipe { direction, from_x, from_y, to_x, to_y, ms } => {
                let ms = ms.unwrap_or(300).clamp(50, 5_000);
                let (from, to) = match (direction, from_x, from_y, to_x, to_y) {
                    (_, Some(fx), Some(fy), Some(tx), Some(ty)) => ((*fx, *fy), (*tx, *ty)),
                    (Some(direction), ..) => finger(size(device, listed)?, *direction),
                    _ => return Err(Error::Invalid("Swipe needs a direction, or fromX, fromY, toX and toY.".into())),
                };
                device.swipe(from, to, ms)?;
                format!("Swiped from ({}, {}) to ({}, {})", from.0, from.1, to.0, to.1)
            }
            Step::Scroll { direction, until_text, max } => {
                let size = size(device, listed)?;
                // Content moving down means the finger moving up.
                let finger_direction = match direction {
                    Direction::Down => Direction::Up,
                    Direction::Up => Direction::Down,
                    Direction::Left => Direction::Right,
                    Direction::Right => Direction::Left,
                };
                let (from, to) = finger(size, finger_direction);
                let max = max.unwrap_or(if until_text.is_some() { 8 } else { 1 }).clamp(1, 30);
                match until_text {
                    None => {
                        for _ in 0..max {
                            device.swipe(from, to, 400)?;
                            sleep(SETTLE);
                        }
                        format!("Scrolled {} ×{max}", format!("{direction:?}").to_lowercase())
                    }
                    Some(text) => {
                        let mut scrolls = 0;
                        loop {
                            if device.dump()?.has_text(text) {
                                break format!("Scrolled {} times until {text:?} showed", scrolls);
                            }
                            if scrolls == max {
                                return Err(Error::Failed(format!("{text:?} didn't show after {max} scrolls.")));
                            }
                            device.swipe(from, to, 400)?;
                            sleep(SETTLE * 2);
                            scrolls += 1;
                        }
                    }
                }
            }
            Step::Type { text, submit } => {
                device.type_text(text)?;
                if *submit {
                    device.key("enter")?;
                }
                let n = text.chars().count();
                format!("Typed {n} characters{}", if *submit { " and pressed enter" } else { "" })
            }
            Step::Key { key } => {
                device.key(key)?;
                format!("Pressed {key}")
            }
            Step::Wait { ms } => {
                let ms = (*ms).min(30_000);
                sleep(Duration::from_millis(ms));
                return Ok(format!("Waited {ms} ms"));
            }
            Step::WaitFor { text, id, gone, timeout_ms } => {
                let query = text.as_deref().or(id.as_deref()).ok_or_else(|| Error::Invalid("waitFor needs text or id.".into()))?;
                let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000).min(60_000));
                let start = Instant::now();
                loop {
                    let shown = device.dump()?.has_text(query);
                    if shown != *gone {
                        let what = if *gone { "went away" } else { "showed" };
                        return Ok(format!("{query:?} {what} after {:.1} s", start.elapsed().as_secs_f64()));
                    }
                    if start.elapsed() > timeout {
                        let what = if *gone { "was still there" } else { "didn't show" };
                        return Err(Error::Failed(format!("{query:?} {what} after {} s.", timeout.as_secs())));
                    }
                    sleep(Duration::from_millis(500));
                }
            }
            Step::OpenUrl { url } => {
                device.open_url(url)?;
                format!("Opened {url}")
            }
        };
        sleep(SETTLE);
        Ok(done)
    }

    fn logs(
        &self,
        device: &Device,
        app: Option<&str>,
        grep: Option<&str>,
        since: Option<u64>,
        lines: Option<usize>,
        level: Option<Level>,
    ) -> Result<String> {
        let grep = grep
            .filter(|g| !g.is_empty())
            .map(|g| Regex::new(&format!("(?i){g}")).map_err(|e| Error::Invalid(format!("Bad grep pattern: {e}"))))
            .transpose()?;
        let level = level.map(Level::as_str);
        let (raw, whose) = match device.platform {
            Platform::Android => {
                let package = self.app_for(device, app).or_else(|| android::foreground_package(device));
                let whose = package.clone().unwrap_or_else(|| "the whole device".into());
                (android::logs(device, package.as_deref(), since, level)?, whose)
            }
            Platform::Ios => {
                let bundle = self.need_app(device, app)?;
                (ios::logs(device, &bundle, since.unwrap_or(IOS_LOG_SECONDS), level)?, bundle)
            }
        };
        let digest = logs::digest(&raw, grep.as_ref(), lines.unwrap_or(LOG_LINES).clamp(1, 500));
        Ok(format!("Log of {whose}: {digest}"))
    }

    fn app_data(
        &self,
        device: &Device,
        app: Option<&str>,
        op: DataOp,
        path: Option<&str>,
        query: Option<&str>,
        grep: Option<&str>,
    ) -> Result<String> {
        let app = match (self.app_for(device, app), device.platform) {
            (Some(app), _) => app,
            (None, Platform::Android) => android::foreground_package(device).ok_or_else(|| Error::Invalid("Name the app.".into()))?,
            (None, Platform::Ios) => self.need_app(device, None)?,
        };
        let grep = grep
            .filter(|g| !g.is_empty())
            .map(|g| Regex::new(&format!("(?i){g}")).map_err(|e| Error::Invalid(format!("Bad grep pattern: {e}"))))
            .transpose()?;
        let path = path.map(str::trim).filter(|p| !p.is_empty());
        let need_path = || path.ok_or_else(|| Error::Invalid("Give the file's path inside the app's data folder.".into()));
        match device.platform {
            Platform::Android => match op {
                DataOp::Ls => android::data_ls(device, &app, path.unwrap_or(".")),
                DataOp::Read => {
                    let path = need_path()?;
                    let bytes = android::data_read(device, &app, path)?.ok_or_else(|| Error::Failed(format!("{path} doesn't exist.")))?;
                    Ok(data::render_file(&bytes, grep.as_ref()))
                }
                DataOp::Sql => {
                    let path = need_path()?;
                    let sql = query.ok_or_else(|| Error::Invalid("Give the SQL to run as query.".into()))?;
                    let db = android::data_read(device, &app, path)?.ok_or_else(|| Error::Failed(format!("{path} doesn't exist.")))?;
                    let wal = android::data_read(device, &app, &format!("{path}-wal")).ok().flatten();
                    data::query(&db, wal.as_deref(), sql)
                }
            },
            Platform::Ios => {
                let root = ios::container(device, &app)?;
                let relative = path.unwrap_or("");
                if Path::new(relative).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
                    return Err(Error::Invalid("Give a path inside the app's data folder, without .. or a leading /.".into()));
                }
                let full = root.join(relative);
                match op {
                    DataOp::Ls => list_dir(&full),
                    DataOp::Read => {
                        let path = need_path()?;
                        if path.ends_with(".plist") {
                            let out = exec::run(Path::new("/usr/bin/plutil"), &["-p", full.to_str().unwrap_or_default()], exec::SHORT)?.ok()?;
                            return Ok(data::render_file(out.as_bytes(), grep.as_ref()));
                        }
                        Ok(data::render_file(&std::fs::read(&full)?, grep.as_ref()))
                    }
                    DataOp::Sql => {
                        need_path()?;
                        let sql = query.ok_or_else(|| Error::Invalid("Give the SQL to run as query.".into()))?;
                        let db = std::fs::read(&full)?;
                        let wal = std::fs::read(format!("{}-wal", full.display())).ok();
                        data::query(&db, wal.as_deref(), sql)
                    }
                }
            }
        }
    }
}

/// The point of an act's target, and how to describe it.
fn locate(device: &Device, target: &Target, listed: Option<&Screen>) -> Result<((i32, i32), String)> {
    if let Some(n) = target.element {
        let screen = listed.ok_or_else(|| Error::Invalid("There's no element list yet: call `screen` first, or tap by text.".into()))?;
        let element = n
            .checked_sub(1)
            .and_then(|i| screen.elements.get(i))
            .ok_or_else(|| Error::Invalid(format!("There's no element [{n}]; the last list had {}.", screen.elements.len())))?;
        return Ok((element.center(), describe(Some(n), element)));
    }
    if let (Some(x), Some(y)) = (target.x, target.y) {
        return Ok(((x, y), format!("({x}, {y})")));
    }
    let screen = device.dump()?;
    if let Some(id) = target.id.as_deref() {
        let element = screen.elements.iter().find(|e| e.id.eq_ignore_ascii_case(id.trim()));
        return element.map(|e| (e.center(), describe(None, e))).ok_or_else(|| Error::Failed(format!("Nothing on screen has id {id:?}.")));
    }
    if let Some(text) = target.text.as_deref() {
        return match screen.find(text).first() {
            Some((_, e)) => Ok((e.center(), describe(None, e))),
            None => Err(Error::Failed(format!("Nothing on screen matches {text:?}."))),
        };
    }
    Err(Error::Invalid("Say what to act on: element, text, id, or x and y.".into()))
}

fn describe(n: Option<usize>, e: &Element) -> String {
    let (x, y) = e.center();
    let number = n.map(|n| format!("[{n}] ")).unwrap_or_default();
    if e.label.is_empty() {
        format!("{number}{} at ({x}, {y})", e.role)
    } else {
        format!("{number}{} {:?} at ({x}, {y})", e.role, ui::clip(&e.label, 40))
    }
}

fn size(device: &Device, listed: Option<&Screen>) -> Result<(i32, i32)> {
    match listed {
        Some(s) if s.width > 0 && s.height > 0 => Ok((s.width, s.height)),
        _ => device.dump().map(|s| (s.width, s.height)),
    }
}

/// A swipe across the middle of the screen with the finger moving in `direction`.
fn finger((w, h): (i32, i32), direction: Direction) -> ((i32, i32), (i32, i32)) {
    let (cx, cy) = (w / 2, h / 2);
    match direction {
        Direction::Up => ((cx, h * 7 / 10), (cx, h * 3 / 10)),
        Direction::Down => ((cx, h * 3 / 10), (cx, h * 7 / 10)),
        Direction::Left => ((w * 8 / 10, cy), (w * 2 / 10, cy)),
        Direction::Right => ((w * 2 / 10, cy), (w * 8 / 10, cy)),
    }
}

fn list_dir(dir: &Path) -> Result<String> {
    let mut entries: Vec<String> = std::fs::read_dir(dir)?
        .flatten()
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.metadata() {
                Ok(m) if m.is_dir() => format!("{name}/"),
                Ok(m) => format!("{name}  {} bytes", m.len()),
                Err(_) => name,
            }
        })
        .collect();
    entries.sort();
    if entries.is_empty() {
        return Ok("The folder is empty.".into());
    }
    Ok(entries.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_from_the_sidecar_shape() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "action": "act",
            "steps": [
                { "do": "tap", "element": 4 },
                { "do": "tap", "text": "Profile" },
                { "do": "type", "text": "hi", "submit": true },
                { "do": "scroll", "direction": "down", "untilText": "Robin's Voice" },
                { "do": "waitFor", "text": "Home", "timeoutMs": 5000 },
                { "do": "key", "key": "back" }
            ]
        }))
        .unwrap();
        let Request::Act { device, steps, observe, .. } = request else { panic!("not act") };
        assert_eq!(device, None);
        assert_eq!(observe, Observe::Elements);
        assert_eq!(steps[0], Step::Tap { target: Target { element: Some(4), ..Target::default() } });
        assert_eq!(steps[1], Step::Tap { target: Target { text: Some("Profile".into()), ..Target::default() } });
        assert_eq!(steps[2], Step::Type { text: "hi".into(), submit: true });
        assert_eq!(steps[3], Step::Scroll { direction: Direction::Down, until_text: Some("Robin's Voice".into()), max: None });
        assert_eq!(steps[4], Step::WaitFor { text: Some("Home".into()), id: None, gone: false, timeout_ms: Some(5000) });

        let request: Request = serde_json::from_value(serde_json::json!({
            "action": "appData", "op": "sql", "path": "databases/clevertap", "query": "select 1"
        }))
        .unwrap();
        assert!(matches!(request, Request::AppData { op: DataOp::Sql, .. }));
    }

    #[test]
    fn swipes_cross_the_middle() {
        assert_eq!(finger((1000, 2000), Direction::Up), ((500, 1400), (500, 600)));
        assert_eq!(finger((1000, 2000), Direction::Right), ((200, 1000), (800, 1000)));
    }
}
