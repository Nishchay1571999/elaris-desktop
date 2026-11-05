//! iOS simulators: `xcrun simctl` for devices, apps, URLs, screenshots and
//! logs, and AXe for the screen's elements and touches. Coordinates are points.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::exec::{self, LONG, Output, SHORT};
use crate::ui::{self, Screen};
use crate::{AppOp, Device, Error, Platform, Result};

fn simctl(args: &[&str], timeout: Duration) -> Result<Output> {
    let mut all = vec!["simctl"];
    all.extend_from_slice(args);
    exec::run(exec::xcrun()?, &all, timeout)
}

fn axe(device: &Device, args: &[&str]) -> Result<String> {
    let mut all = args.to_vec();
    all.extend_from_slice(&["--udid", device.id.as_str()]);
    exec::run(exec::axe()?, &all, SHORT)?.ok()
}

/// Every available iOS simulator, booted or not.
pub fn list() -> Result<Vec<Device>> {
    let out = simctl(&["list", "-j", "devices", "available"], SHORT)?.ok()?;
    let json: Value = serde_json::from_str(&out).map_err(|e| Error::Failed(format!("Couldn't read simctl's device list: {e}")))?;
    let mut devices = Vec::new();
    let Some(runtimes) = json.get("devices").and_then(Value::as_object) else { return Ok(devices) };
    for (runtime, sims) in runtimes {
        // com.apple.CoreSimulator.SimRuntime.iOS-26-2 → iOS 26.2
        let Some(version) = runtime.rsplit('.').next().and_then(|r| r.strip_prefix("iOS-")) else { continue };
        for sim in sims.as_array().into_iter().flatten() {
            let s = |k: &str| sim.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            devices.push(Device {
                platform: Platform::Ios,
                id: s("udid"),
                name: s("name"),
                booted: s("state") == "Booted",
                detail: format!("iOS {}", version.replace('-', ".")),
            });
        }
    }
    Ok(devices)
}

/// Boots the simulator, shows it in Simulator.app and waits until it's ready.
pub fn boot(device: &Device) -> Result<()> {
    let out = simctl(&["boot", &device.id], LONG)?;
    if !out.success && !out.complaint().contains("current state: Booted") {
        return Err(Error::Failed(out.complaint()));
    }
    let _ = exec::run(Path::new("/usr/bin/open"), &["-a", "Simulator"], SHORT);
    simctl(&["bootstatus", &device.id, "-b"], LONG)?.ok().map(drop)
}

pub fn dump(device: &Device) -> Result<Screen> {
    ui::parse_ios(&axe(device, &["describe-ui"])?)
}

pub fn tap(device: &Device, x: i32, y: i32) -> Result<()> {
    axe(device, &["tap", "-x", &x.to_string(), "-y", &y.to_string()]).map(drop)
}

pub fn long_press(device: &Device, x: i32, y: i32, ms: u64) -> Result<()> {
    let delay = format!("{:.2}", ms as f64 / 1000.0);
    axe(device, &["touch", "-x", &x.to_string(), "-y", &y.to_string(), "--down", "--up", "--delay", &delay]).map(drop)
}

pub fn swipe(device: &Device, from: (i32, i32), to: (i32, i32), ms: u64) -> Result<()> {
    let duration = format!("{:.2}", ms as f64 / 1000.0);
    let args = [
        "swipe",
        "--start-x",
        &from.0.to_string(),
        "--start-y",
        &from.1.to_string(),
        "--end-x",
        &to.0.to_string(),
        "--end-y",
        &to.1.to_string(),
        "--duration",
        &duration,
    ]
    .map(|s| s.to_string());
    axe(device, &args.iter().map(String::as_str).collect::<Vec<_>>()).map(drop)
}

pub fn type_text(device: &Device, text: &str) -> Result<()> {
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            key(device, "enter")?;
        }
        if !line.is_empty() {
            // Through a file, so text starting with "-" isn't read as a flag.
            let file = exec::temp_path("txt");
            std::fs::write(&file, line)?;
            let typed = axe(device, &["type", "--file", file.to_str().unwrap_or_default()]);
            let _ = std::fs::remove_file(&file);
            typed?;
        }
    }
    Ok(())
}

pub fn key(device: &Device, name: &str) -> Result<()> {
    // HID usage codes for the keys AXe sends with `key`.
    let hid = match name.trim().to_lowercase().as_str() {
        "home" => return axe(device, &["button", "home"]).map(drop),
        "lock" | "power" => return axe(device, &["button", "lock"]).map(drop),
        "back" => {
            return Err(Error::Invalid("iOS has no back key. Tap the screen's back button, or swipe right from the left edge.".into()));
        }
        "enter" | "return" => "40",
        "escape" | "esc" => "41",
        "delete" | "backspace" => "42",
        "tab" => "43",
        "right" => "79",
        "left" => "80",
        "down" => "81",
        "up" => "82",
        other => return Err(Error::Invalid(format!("Unknown key {other:?}. On iOS use home, lock, enter, escape, delete, tab or up/down/left/right."))),
    };
    axe(device, &["key", hid]).map(drop)
}

pub fn open_url(device: &Device, url: &str) -> Result<()> {
    simctl(&["openurl", &device.id, url], SHORT)?.ok().map(drop)
}

/// A JPEG of the screen, `width` pixels wide.
pub fn screenshot(device: &Device, width: u32) -> Result<Vec<u8>> {
    let png = exec::temp_path("png");
    let result = (|| {
        simctl(&["io", &device.id, "screenshot", "--type=png", png.to_str().unwrap_or_default()], SHORT)?.ok()?;
        exec::shrink_to_jpeg(&png, width)
    })();
    let _ = std::fs::remove_file(&png);
    result
}

/// A field of `simctl appinfo`'s old-style plist, e.g. `CFBundleExecutable = hiRobin;`.
fn plist_field(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.trim().split_once(" = ")?;
        (k == key).then(|| v.trim_end_matches(';').trim_matches('"').to_string())
    })
}

fn appinfo(device: &Device, bundle: &str) -> Result<String> {
    let out = simctl(&["appinfo", &device.id, bundle], SHORT)?.ok()?;
    if plist_field(&out, "CFBundleIdentifier").is_none() {
        return Err(Error::Failed(format!("{bundle} isn't installed on {}.", device.name)));
    }
    Ok(out)
}

pub fn pid(device: &Device, bundle: &str) -> Option<String> {
    let out = simctl(&["spawn", &device.id, "launchctl", "list"], SHORT).ok()?;
    let tag = format!("UIKitApplication:{bundle}[");
    out.text().lines().find(|l| l.contains(&tag)).and_then(|l| l.split_whitespace().next()).filter(|p| *p != "-").map(str::to_string)
}

pub fn app(device: &Device, op: AppOp, bundle: &str, path: Option<&str>) -> Result<String> {
    Ok(match op {
        AppOp::List => {
            let out = simctl(&["listapps", &device.id], SHORT)?.ok()?;
            let mut ids: Vec<String> = out
                .lines()
                .filter_map(|l| {
                    let (k, v) = l.trim().split_once(" = ")?;
                    (k == "CFBundleIdentifier").then(|| v.trim_end_matches(';').trim_matches('"').to_string())
                })
                .filter(|id| !id.starts_with("com.apple."))
                .collect();
            ids.sort();
            ids.dedup();
            format!("{} apps installed by the user:\n{}", ids.len(), ids.join("\n"))
        }
        AppOp::Launch => launch(device, bundle)?,
        AppOp::Stop => match simctl(&["terminate", &device.id, bundle], SHORT)?.ok() {
            Ok(_) => format!("Stopped {bundle}."),
            Err(_) => format!("{bundle} wasn't running."),
        },
        AppOp::Restart => {
            let _ = simctl(&["terminate", &device.id, bundle], SHORT);
            launch(device, bundle)?.replacen("Launched", "Restarted", 1)
        }
        AppOp::Install => {
            let path = path.ok_or_else(|| Error::Invalid("Give the path of the .app to install.".into()))?;
            simctl(&["install", &device.id, path], LONG)?.ok()?;
            format!("Installed {path}.")
        }
        AppOp::Uninstall => {
            simctl(&["uninstall", &device.id, bundle], SHORT)?.ok()?;
            format!("Uninstalled {bundle}.")
        }
        AppOp::Clear => {
            return Err(Error::Invalid(
                "iOS simulators can't clear one app's data. Uninstall and reinstall it, or erase the simulator.".into(),
            ));
        }
        AppOp::Info => {
            let out = appinfo(device, bundle)?;
            let field = |k: &str| plist_field(&out, k).unwrap_or_default();
            let running = match pid(device, bundle) {
                Some(pid) => format!("running (pid {pid})"),
                None => "not running".into(),
            };
            format!(
                "{bundle} · {} version {} ({}) · executable {} · {running}",
                field("CFBundleDisplayName"),
                field("CFBundleShortVersionString"),
                field("CFBundleVersion"),
                field("CFBundleExecutable"),
            )
        }
    })
}

fn launch(device: &Device, bundle: &str) -> Result<String> {
    let out = simctl(&["launch", &device.id, bundle], SHORT)?.ok()?;
    // "com.example.app: 1234"
    let pid = out.trim().rsplit(": ").next().unwrap_or("").to_string();
    Ok(format!("Launched {bundle} (pid {pid})."))
}

/// The unified log of the app's process over the last `since` seconds.
pub fn logs(device: &Device, bundle: &str, since: u64, level: Option<&str>) -> Result<String> {
    let executable = plist_field(&appinfo(device, bundle)?, "CFBundleExecutable")
        .ok_or_else(|| Error::Failed(format!("Couldn't tell {bundle}'s process name.")))?;
    let mut predicate = format!("process == \"{executable}\"");
    // The unified log's levels don't line up with Android's; only errors narrow it.
    if level == Some("error") {
        predicate.push_str(" AND (messageType == error OR messageType == fault)");
    }
    let last = format!("{since}s");
    let mut args = vec!["spawn", &device.id, "log", "show", "--style", "compact", "--last", &last, "--predicate", &predicate];
    if matches!(level, Some("verbose" | "debug")) {
        args.extend(["--info", "--debug"]);
    }
    simctl(&args, LONG)?.ok()
}

/// The app's data container (Documents, Library, tmp).
pub fn container(device: &Device, bundle: &str) -> Result<PathBuf> {
    let out = simctl(&["get_app_container", &device.id, bundle, "data"], SHORT)?.ok()?;
    Ok(PathBuf::from(out.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_appinfo_fields() {
        let info = "{\n    CFBundleExecutable = hiRobin;\n    CFBundleIdentifier = \"com.robinhomeai.app\";\n}";
        assert_eq!(plist_field(info, "CFBundleExecutable").as_deref(), Some("hiRobin"));
        assert_eq!(plist_field(info, "CFBundleIdentifier").as_deref(), Some("com.robinhomeai.app"));
        assert_eq!(plist_field(info, "Missing"), None);
    }
}
