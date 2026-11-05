//! Finding `adb`, `emulator`, `xcrun` and `axe`, and running them with a time
//! limit. Elaris opened from Finder has a bare `PATH`, so each tool is looked
//! for where its installer puts it, not just on `PATH`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::{Error, Result};

/// How long most device commands may take.
pub const SHORT: Duration = Duration::from_secs(30);
/// Installs, boots and log searches.
pub const LONG: Duration = Duration::from_secs(300);

pub fn adb() -> Result<&'static Path> {
    static ADB: OnceLock<Option<PathBuf>> = OnceLock::new();
    ADB.get_or_init(|| find_sdk_tool("platform-tools/adb")).as_deref().ok_or_else(|| {
        Error::Missing(
            "adb wasn't found. Install Android Studio (or the Android SDK platform-tools), or set ANDROID_HOME to the SDK folder."
                .into(),
        )
    })
}

pub fn emulator() -> Result<&'static Path> {
    static EMULATOR: OnceLock<Option<PathBuf>> = OnceLock::new();
    EMULATOR.get_or_init(|| find_sdk_tool("emulator/emulator")).as_deref().ok_or_else(|| {
        Error::Missing("The Android emulator wasn't found. Install it from Android Studio's SDK Manager, or set ANDROID_HOME.".into())
    })
}

pub fn xcrun() -> Result<&'static Path> {
    static XCRUN: OnceLock<Option<PathBuf>> = OnceLock::new();
    XCRUN.get_or_init(|| find_program("xcrun", &["/usr/bin"])).as_deref().ok_or_else(|| {
        Error::Missing("xcrun wasn't found. iOS simulators need Xcode (xcode-select --install isn't enough).".into())
    })
}

/// AXe, which taps, types and reads the accessibility tree of iOS simulators.
pub fn axe() -> Result<&'static Path> {
    static AXE: OnceLock<Option<PathBuf>> = OnceLock::new();
    AXE.get_or_init(|| find_program("axe", &["/opt/homebrew/bin", "/usr/local/bin"])).as_deref().ok_or_else(|| {
        Error::Missing(
            "AXe isn't installed; iOS simulators need it to read the screen and tap. Ask the user to run `brew install cameroncooke/axe/axe`, then try again."
                .into(),
        )
    })
}

fn find_sdk_tool(relative: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let roots = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(PathBuf::from))
        .chain(home.iter().flat_map(|h| [h.join("Library/Android/sdk"), h.join("Android/Sdk")]));
    for root in roots {
        let path = root.join(relative);
        if path.is_file() {
            return Some(path);
        }
    }
    let name = Path::new(relative).file_name()?.to_str()?;
    find_program(name, &[])
}

fn find_program(name: &str, extra: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(extra.iter().map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// What a finished command printed.
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// Stdout, or an error carrying whatever the command said went wrong.
    pub fn ok(self) -> Result<String> {
        if self.success {
            return Ok(self.text());
        }
        Err(Error::Failed(self.complaint()))
    }

    /// What the command said when it failed: stderr, else stdout.
    pub fn complaint(&self) -> String {
        let said = if self.stderr.trim().is_empty() { self.text() } else { self.stderr.clone() };
        let said = said.trim();
        if said.is_empty() { "The command failed without saying why.".into() } else { said.to_string() }
    }
}

/// Runs `program` with `args`, killing it after `timeout`.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<Output> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let what = std::iter::once(name.as_str()).chain(args.iter().copied().take(4)).collect::<Vec<_>>().join(" ");
            return Err(Error::Timeout(what, timeout.as_secs()));
        }
        sleep(Duration::from_millis(20));
    };
    Ok(Output { success: status.success(), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

/// Starts `program` and leaves it running on its own, e.g. an emulator.
pub fn spawn_detached(program: &Path, args: &[&str]) -> Result<()> {
    Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(())
}

/// A fresh path in the temp folder; the caller removes it.
pub fn temp_path(extension: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("elaris-device-{}-{n}.{extension}", std::process::id()))
}

/// Scales an image to `width` pixels wide as a JPEG, with macOS's `sips`.
pub fn shrink_to_jpeg(source: &Path, width: u32) -> Result<Vec<u8>> {
    let out = temp_path("jpg");
    let result = (|| {
        let width = width.to_string();
        let args = [
            "--resampleWidth",
            &width,
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "70",
            source.to_str().unwrap_or_default(),
            "--out",
            out.to_str().unwrap_or_default(),
        ];
        run(Path::new("/usr/bin/sips"), &args, SHORT)?.ok()?;
        Ok(std::fs::read(&out)?)
    })();
    let _ = std::fs::remove_file(&out);
    result
}
