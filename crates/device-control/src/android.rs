//! Android devices and emulators, through `adb` and `emulator`. Coordinates are
//! screen pixels.

use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::exec::{self, LONG, Output, SHORT};
use crate::ui::{self, Screen};
use crate::{AppOp, Device, Error, Platform, Result};

fn adb(device: &Device, args: &[&str], timeout: Duration) -> Result<Output> {
    let mut all = vec!["-s", device.id.as_str()];
    all.extend_from_slice(args);
    exec::run(exec::adb()?, &all, timeout)
}

/// Runs `command` in the device's shell.
fn shell(device: &Device, command: &str) -> Result<String> {
    adb(device, &["shell", command], SHORT)?.ok()
}

/// `s` quoted for the device's shell.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Running devices and emulators, then emulators that could be started.
pub fn list() -> Result<Vec<Device>> {
    let out = exec::run(exec::adb()?, &["devices", "-l"], SHORT)?.ok()?;
    let mut devices = Vec::new();
    for line in out.lines().skip(1) {
        let mut words = line.split_whitespace();
        let (Some(serial), Some(state)) = (words.next(), words.next()) else { continue };
        let model = words.find_map(|w| w.strip_prefix("model:")).unwrap_or("").replace('_', " ");
        let mut device = Device {
            platform: Platform::Android,
            id: serial.to_string(),
            name: model.clone(),
            booted: state == "device",
            detail: if state == "device" { String::new() } else { state.to_string() },
        };
        if serial.starts_with("emulator-") {
            if let Some(avd) = avd_name(&device) {
                device.name = avd;
            }
        }
        devices.push(device);
    }
    if let Ok(emulator) = exec::emulator() {
        if let Ok(out) = exec::run(emulator, &["-list-avds"], SHORT) {
            for avd in out.text().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("INFO")) {
                if !devices.iter().any(|d| d.name == avd) {
                    devices.push(Device {
                        platform: Platform::Android,
                        id: avd.to_string(),
                        name: avd.to_string(),
                        booted: false,
                        detail: "emulator".into(),
                    });
                }
            }
        }
    }
    Ok(devices)
}

/// The AVD a running emulator was started from.
fn avd_name(device: &Device) -> Option<String> {
    let out = adb(device, &["emu", "avd", "name"], Duration::from_secs(5)).ok()?;
    out.text().lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && l != "OK")
}

/// Starts emulator `avd` and waits until Android has finished booting.
pub fn boot(avd: &str) -> Result<Device> {
    exec::spawn_detached(exec::emulator()?, &["-avd", avd])?;
    let deadline = Instant::now() + LONG;
    let device = loop {
        if let Some(d) = list()?.into_iter().find(|d| d.booted && d.name == avd) {
            break d;
        }
        if Instant::now() > deadline {
            return Err(Error::Failed(format!("Emulator {avd} didn't come up within {} s.", LONG.as_secs())));
        }
        sleep(Duration::from_secs(2));
    };
    while shell(&device, "getprop sys.boot_completed").unwrap_or_default().trim() != "1" {
        if Instant::now() > deadline {
            return Err(Error::Failed(format!("Emulator {avd} started but Android didn't finish booting.")));
        }
        sleep(Duration::from_secs(2));
    }
    Ok(device)
}

pub fn dump(device: &Device) -> Result<Screen> {
    let mut last = String::new();
    // uiautomator refuses while an animation runs ("could not get idle state"); try again.
    for attempt in 0..3 {
        if attempt > 0 {
            sleep(Duration::from_millis(800));
        }
        let out = adb(device, &["exec-out", "uiautomator dump /dev/tty"], SHORT)?;
        last = out.text();
        if last.contains("<hierarchy") {
            return ui::parse_android(&last);
        }
    }
    ui::parse_android(&last)
}

/// The resumed activity, e.g. `com.example/.MainActivity`.
pub fn foreground(device: &Device) -> Option<String> {
    let out = shell(device, "dumpsys activity activities | grep -m1 topResumedActivity").ok()?;
    out.split_whitespace().find(|w| w.contains('/')).map(|w| w.trim_end_matches('}').to_string())
}

pub fn foreground_package(device: &Device) -> Option<String> {
    foreground(device).and_then(|a| a.split('/').next().map(str::to_string))
}

pub fn tap(device: &Device, x: i32, y: i32) -> Result<()> {
    shell(device, &format!("input tap {x} {y}")).map(drop)
}

pub fn long_press(device: &Device, x: i32, y: i32, ms: u64) -> Result<()> {
    shell(device, &format!("input swipe {x} {y} {x} {y} {ms}")).map(drop)
}

pub fn swipe(device: &Device, from: (i32, i32), to: (i32, i32), ms: u64) -> Result<()> {
    shell(device, &format!("input swipe {} {} {} {} {ms}", from.0, from.1, to.0, to.1)).map(drop)
}

pub fn type_text(device: &Device, text: &str) -> Result<()> {
    if !text.is_ascii() {
        return Err(Error::Invalid("Android's `input text` can only type ASCII; paste other text through the app instead.".into()));
    }
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            key(device, "enter")?;
        }
        if !line.is_empty() {
            // `input text` reads %s as a space.
            shell(device, &format!("input text {}", quote(&line.replace(' ', "%s"))))?;
        }
    }
    Ok(())
}

pub fn key(device: &Device, name: &str) -> Result<()> {
    let code = keycode(name)?;
    shell(device, &format!("input keyevent {code}")).map(drop)
}

fn keycode(name: &str) -> Result<String> {
    let lower = name.trim().to_lowercase();
    let code = match lower.as_str() {
        "back" => "KEYCODE_BACK",
        "home" => "KEYCODE_HOME",
        "enter" | "return" => "KEYCODE_ENTER",
        "delete" | "backspace" => "KEYCODE_DEL",
        "tab" => "KEYCODE_TAB",
        "escape" | "esc" => "KEYCODE_ESCAPE",
        "menu" => "KEYCODE_MENU",
        "recents" | "app_switch" => "KEYCODE_APP_SWITCH",
        "up" => "KEYCODE_DPAD_UP",
        "down" => "KEYCODE_DPAD_DOWN",
        "left" => "KEYCODE_DPAD_LEFT",
        "right" => "KEYCODE_DPAD_RIGHT",
        "power" => "KEYCODE_POWER",
        "volume_up" => "KEYCODE_VOLUME_UP",
        "volume_down" => "KEYCODE_VOLUME_DOWN",
        _ if lower.starts_with("keycode_") || lower.chars().all(|c| c.is_ascii_digit()) => return Ok(name.trim().to_uppercase()),
        _ => return Err(Error::Invalid(format!("Unknown key {name:?}. Use back, home, enter, delete, tab, escape, menu, recents, up/down/left/right, power, or an Android KEYCODE_ name."))),
    };
    Ok(code.into())
}

pub fn open_url(device: &Device, url: &str) -> Result<()> {
    let out = shell(device, &format!("am start -W -a android.intent.action.VIEW -d {}", quote(url)))?;
    if out.contains("Error") {
        return Err(Error::Failed(out.trim().to_string()));
    }
    Ok(())
}

/// A JPEG of the screen, `width` pixels wide.
pub fn screenshot(device: &Device, width: u32) -> Result<Vec<u8>> {
    let out = adb(device, &["exec-out", "screencap -p"], SHORT)?;
    if !out.success || !out.stdout.starts_with(b"\x89PNG") {
        return Err(Error::Failed(format!("screencap failed: {}", out.complaint())));
    }
    let png = exec::temp_path("png");
    std::fs::write(&png, &out.stdout)?;
    let jpeg = exec::shrink_to_jpeg(&png, width);
    let _ = std::fs::remove_file(&png);
    jpeg
}

pub fn pid(device: &Device, package: &str) -> Option<String> {
    let out = adb(device, &["shell", &format!("pidof {package}")], SHORT).ok()?;
    out.text().split_whitespace().next().map(str::to_string)
}

pub fn app(device: &Device, op: AppOp, package: &str, path: Option<&str>) -> Result<String> {
    Ok(match op {
        AppOp::List => {
            let out = shell(device, "pm list packages -3")?;
            let mut packages: Vec<&str> = out.lines().filter_map(|l| l.trim().strip_prefix("package:")).collect();
            packages.sort_unstable();
            format!("{} apps installed by the user:\n{}", packages.len(), packages.join("\n"))
        }
        AppOp::Launch => launch(device, package)?,
        AppOp::Stop => {
            shell(device, &format!("am force-stop {package}"))?;
            format!("Stopped {package}.")
        }
        AppOp::Restart => {
            shell(device, &format!("am force-stop {package}"))?;
            sleep(Duration::from_millis(500));
            launch(device, package)?.replacen("Launched", "Restarted", 1)
        }
        AppOp::Install => {
            let path = path.ok_or_else(|| Error::Invalid("Give the path of the .apk to install.".into()))?;
            let out = adb(device, &["install", "-r", path], LONG)?.ok()?;
            format!("Installed {path}: {}", out.lines().last().unwrap_or("").trim())
        }
        AppOp::Uninstall => {
            let out = adb(device, &["uninstall", package], SHORT)?.ok()?;
            format!("Uninstalled {package}: {}", out.trim())
        }
        AppOp::Clear => {
            let out = shell(device, &format!("pm clear {package}"))?;
            format!("Cleared {package}'s data and cache: {}", out.trim())
        }
        AppOp::Info => info(device, package)?,
    })
}

fn launch(device: &Device, package: &str) -> Result<String> {
    let out = shell(device, &format!("monkey -p {package} -c android.intent.category.LAUNCHER 1"))?;
    if out.contains("No activities found") || out.contains("monkey aborted") {
        return Err(Error::Failed(format!("{package} has no launchable activity; is it installed? (app list shows what is)")));
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(pid) = pid(device, package) {
            return Ok(format!("Launched {package} (pid {pid})."));
        }
        if Instant::now() > deadline {
            return Ok(format!("Launched {package}, but it isn't running yet; it may have crashed (check logs)."));
        }
        sleep(Duration::from_millis(300));
    }
}

fn info(device: &Device, package: &str) -> Result<String> {
    let out = shell(device, &format!("dumpsys package {package}"))?;
    if !out.contains(&format!("Package [{package}]")) {
        return Err(Error::Failed(format!("{package} isn't installed.")));
    }
    let field = |key: &str| {
        out.lines().find_map(|l| l.trim().split_whitespace().find_map(|w| w.strip_prefix(key)).map(str::to_string))
    };
    let mut parts = vec![package.to_string()];
    if let Some(name) = field("versionName=") {
        parts.push(format!("version {name} ({})", field("versionCode=").unwrap_or_default()));
    }
    let debuggable = out.lines().any(|l| l.contains("flags=[") && l.contains("DEBUGGABLE"));
    parts.push(if debuggable { "debuggable".into() } else { "not debuggable (app_data can't read it)".into() });
    if let Some(line) = out.lines().find(|l| l.contains("lastUpdateTime=")) {
        parts.push(format!("updated {}", line.trim().trim_start_matches("lastUpdateTime=")));
    }
    parts.push(match pid(device, package) {
        Some(pid) => format!("running (pid {pid})"),
        None => "not running".into(),
    });
    Ok(parts.join(" · "))
}

/// The log of `package`'s process, or the whole device's log without one.
pub fn logs(device: &Device, package: Option<&str>, since: Option<u64>, level: Option<&str>) -> Result<String> {
    let mut command = "logcat -d -v time".to_string();
    if let Some(package) = package {
        let pid = pid(device, package).ok_or_else(|| Error::Failed(format!("{package} isn't running, so it has no log to read. Launch it first.")))?;
        command.push_str(&format!(" --pid={pid}"));
    }
    if let Some(seconds) = since {
        command.push_str(&format!(" -T \"$(( $(date +%s) - {seconds} )).000\""));
    }
    if let Some(level) = level {
        let letter = match level {
            "verbose" => "V",
            "debug" => "D",
            "info" => "I",
            "warn" => "W",
            _ => "E",
        };
        command.push_str(&format!(" '*:{letter}'"));
    }
    adb(device, &["shell", &command], exec::LONG)?.ok()
}

/// Lists a folder inside the app's sandbox (`/data/data/<package>`).
pub fn data_ls(device: &Device, package: &str, path: &str) -> Result<String> {
    let out = adb(device, &["shell", &format!("run-as {package} ls -la {}", quote(path))], SHORT)?;
    let text = if out.success { out.text() } else { return Err(run_as_error(package, &out.complaint())) };
    if text.starts_with("run-as:") {
        return Err(run_as_error(package, &text));
    }
    Ok(text.trim_end().to_string())
}

/// A file inside the app's sandbox, or `None` if it doesn't exist.
pub fn data_read(device: &Device, package: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let out = adb(device, &["exec-out", &format!("run-as {package} cat {}", quote(path))], LONG)?;
    let said = String::from_utf8_lossy(&out.stdout[..out.stdout.len().min(300)]).into_owned();
    if said.starts_with("run-as:") {
        return Err(run_as_error(package, &said));
    }
    if said.contains("No such file or directory") && out.stdout.len() < 300 {
        return Ok(None);
    }
    if !out.success {
        return Err(Error::Failed(out.complaint()));
    }
    Ok(Some(out.stdout))
}

fn run_as_error(package: &str, said: &str) -> Error {
    let said = said.trim();
    if said.contains("not debuggable") {
        Error::Failed(format!("{package} isn't a debuggable build, so Android won't let anything read its files. Use a debug build. ({said})"))
    } else {
        Error::Failed(said.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_keycodes() {
        assert_eq!(keycode("Back").unwrap(), "KEYCODE_BACK");
        assert_eq!(keycode("keycode_camera").unwrap(), "KEYCODE_CAMERA");
        assert_eq!(keycode("66").unwrap(), "66");
        assert!(keycode("hyper").is_err());
    }

    #[test]
    fn shell_quoting_survives_quotes() {
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
