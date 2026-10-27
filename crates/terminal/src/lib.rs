//! Pseudo-terminals for the desktop app: the user's shells in terminal tabs and
//! the commands the agent runs through its `terminal-access` tool. Each one's
//! output is read on a thread of its own, kept as scrollback, and passed to
//! whoever subscribes (the UI's emulator). A terminal whose process has ended
//! stays readable until it's closed, so its last output isn't lost.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Scrollback kept per terminal, for emulators that attach late and for the agent.
const SCROLLBACK: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Couldn't start the terminal: {0}")]
    Spawn(String),
    #[error("Terminal {0} has been closed")]
    Closed(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// What a terminal runs.
#[derive(Debug, Clone)]
pub enum Program {
    /// The user's interactive login shell.
    Shell,
    /// One command line, run by the user's shell with their full environment;
    /// the terminal's process ends when it does.
    Command(String),
}

pub struct Spawn<'a> {
    pub cwd: &'a Path,
    pub cols: u16,
    pub rows: u16,
    pub program: Program,
    /// Who started it, e.g. the chat whose agent did; `None` for the user's own tabs.
    pub owner: Option<String>,
    pub title: String,
}

/// What a subscriber hears: output as it arrives (scrollback first), then the exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Output(Vec<u8>),
    /// The exit code, if the process reported one.
    Exit(Option<u32>),
}

/// Called with each event; returning `false` unsubscribes (e.g. a closed window).
pub type Sink = Box<dyn FnMut(Event) -> bool + Send>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub id: u32,
    pub title: String,
    pub owner: Option<String>,
    /// `Some` once the process has ended, holding its exit code if any.
    pub exit: Option<Option<u32>>,
}

/// Output read from a position in a terminal's stream; see [`Terminals::read`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub bytes: Vec<u8>,
    /// Where to read from next time.
    pub next: u64,
    /// Some output before `bytes` was older than the scrollback and is gone.
    pub skipped: bool,
    pub exit: Option<Option<u32>>,
}

#[derive(Default)]
struct Shared {
    scrollback: VecDeque<u8>,
    /// Bytes ever printed; positions in the stream count from here.
    total: u64,
    exit: Option<Option<u32>>,
    sinks: Vec<Sink>,
}

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shared: Arc<Mutex<Shared>>,
    title: String,
    owner: Option<String>,
}

/// Every open terminal, by id.
#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<u32, Pty>>,
    next: AtomicU32,
}

impl Terminals {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a terminal and returns its id.
    pub fn spawn(&self, spawn: Spawn<'_>) -> Result<u32> {
        let command = match &spawn.program {
            Program::Shell => shell(),
            Program::Command(line) => shell_command(line),
        };
        self.spawn_command(command, spawn)
    }

    fn spawn_command(&self, mut command: CommandBuilder, spawn: Spawn<'_>) -> Result<u32> {
        let pair = native_pty_system().openpty(size(spawn.cols, spawn.rows)).map_err(spawn_err)?;
        command.cwd(spawn.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Elaris");
        // Apps launched from the Dock get no locale, and shells then mangle UTF-8.
        if std::env::var_os("LANG").is_none() {
            command.env("LANG", "en_US.UTF-8");
        }
        let mut child = pair.slave.spawn_command(command).map_err(spawn_err)?;
        // Only the child keeps the slave open, so reads end when it exits.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(spawn_err)?;
        let writer = pair.master.take_writer().map_err(spawn_err)?;
        let killer = child.clone_killer();
        let shared = Arc::new(Mutex::new(Shared::default()));

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().unwrap().insert(
            id,
            Pty { master: pair.master, writer, killer, shared: shared.clone(), title: spawn.title, owner: spawn.owner },
        );

        thread::Builder::new().name(format!("terminal-{id}")).spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => shared.lock().unwrap().push(&buf[..n]),
                }
            }
            let code = child.wait().ok().map(|status| status.exit_code());
            let mut shared = shared.lock().unwrap();
            shared.exit = Some(code);
            shared.sinks.retain_mut(|sink| sink(Event::Exit(code)));
        })?;
        Ok(id)
    }

    /// Follows a terminal: `sink` gets its scrollback at once, then everything
    /// after, then its exit (straight away if it has already ended).
    pub fn subscribe(&self, id: u32, mut sink: Sink) -> Result<()> {
        let shared = self.shared(id)?;
        let mut shared = shared.lock().unwrap();
        if !shared.scrollback.is_empty() {
            let snapshot: Vec<u8> = shared.scrollback.iter().copied().collect();
            if !sink(Event::Output(snapshot)) {
                return Ok(());
            }
        }
        match shared.exit {
            Some(code) => {
                sink(Event::Exit(code));
            }
            None => shared.sinks.push(sink),
        }
        Ok(())
    }

    /// Output from position `from` in the stream (0 is the start) to now.
    pub fn read(&self, id: u32, from: u64) -> Result<Chunk> {
        let shared = self.shared(id)?;
        let shared = shared.lock().unwrap();
        let start = shared.total - shared.scrollback.len() as u64;
        let skip = from.max(start) - start;
        Ok(Chunk {
            bytes: shared.scrollback.iter().skip(skip as usize).copied().collect(),
            next: shared.total,
            skipped: from < start,
            exit: shared.exit,
        })
    }

    pub fn info(&self, id: u32) -> Result<Info> {
        let open = self.open.lock().unwrap();
        let pty = open.get(&id).ok_or(Error::Closed(id))?;
        Ok(info(id, pty))
    }

    /// Every open terminal, oldest first.
    pub fn list(&self) -> Vec<Info> {
        let open = self.open.lock().unwrap();
        let mut all: Vec<Info> = open.iter().map(|(&id, pty)| info(id, pty)).collect();
        all.sort_by_key(|info| info.id);
        all
    }

    /// Sends keystrokes or pasted text to the process.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<()> {
        let mut open = self.open.lock().unwrap();
        let pty = open.get_mut(&id).ok_or(Error::Closed(id))?;
        pty.writer.write_all(data)?;
        pty.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        let open = self.open.lock().unwrap();
        let pty = open.get(&id).ok_or(Error::Closed(id))?;
        pty.master.resize(size(cols, rows)).map_err(spawn_err)
    }

    /// Ends the process (if it's still running) and forgets the terminal.
    /// Subscribers still hear the exit.
    pub fn kill(&self, id: u32) {
        let removed = self.open.lock().unwrap().remove(&id);
        if let Some(mut pty) = removed {
            let _ = pty.killer.kill();
        }
    }

    /// Kills every terminal `which` picks.
    pub fn kill_where(&self, which: impl Fn(&Info) -> bool) {
        let mut open = self.open.lock().unwrap();
        let ids: Vec<u32> = open.iter().filter(|(id, pty)| which(&info(**id, pty))).map(|(id, _)| *id).collect();
        for id in ids {
            if let Some(mut pty) = open.remove(&id) {
                let _ = pty.killer.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        self.kill_where(|_| true);
    }

    fn shared(&self, id: u32) -> Result<Arc<Mutex<Shared>>> {
        self.open.lock().unwrap().get(&id).map(|pty| pty.shared.clone()).ok_or(Error::Closed(id))
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        self.kill_all();
    }
}

impl Shared {
    fn push(&mut self, bytes: &[u8]) {
        self.scrollback.extend(bytes);
        let excess = self.scrollback.len().saturating_sub(SCROLLBACK);
        self.scrollback.drain(..excess);
        self.total += bytes.len() as u64;
        self.sinks.retain_mut(|sink| sink(Event::Output(bytes.to_vec())));
    }
}

fn info(id: u32, pty: &Pty) -> Info {
    Info { id, title: pty.title.clone(), owner: pty.owner.clone(), exit: pty.shared.lock().unwrap().exit }
}

/// Terminal output as plain text for the agent: colours and cursor movement
/// dropped, and lines redrawn with `\r` (progress bars) reduced to what they
/// finally showed.
pub fn plain_text(bytes: &[u8]) -> String {
    // Lines first: stripping escapes also drops the `\r`s that mark redraws.
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let shown = line.rsplit('\r').find(|part| !part.is_empty()).unwrap_or("");
            strip_ansi_escapes::strip_str(shown)
        })
        .collect();
    lines.join("\n")
}

/// portable-pty reports errors as `anyhow::Error`.
fn spawn_err(error: impl std::fmt::Display) -> Error {
    Error::Spawn(error.to_string())
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

#[cfg(not(windows))]
fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// The user's shell as a login shell, so a GUI-launched app still gets their PATH.
fn shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into()))
    }
    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new(user_shell());
        command.arg("-l");
        command
    }
}

/// `line` run by the user's shell, login and interactive so their rc files set
/// up PATH (nvm, pyenv…) as in their own terminal.
fn shell_command(line: &str) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
        command.args(["/C", line]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new(user_shell());
        command.args(["-l", "-i", "-c", line]);
        command
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    fn start(terminals: &Terminals, command: CommandBuilder, dir: &Path) -> u32 {
        let spawn = Spawn { cwd: dir, cols: 80, rows: 24, program: Program::Shell, owner: None, title: "t".into() };
        terminals.spawn_command(command, spawn).unwrap()
    }

    fn sh(script: &str) -> CommandBuilder {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    /// Reads from 0 until `done` holds for the text so far.
    fn wait_for(terminals: &Terminals, id: u32, done: impl Fn(&Chunk) -> bool) -> Chunk {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let chunk = terminals.read(id, 0).unwrap();
            if done(&chunk) || Instant::now() > deadline {
                return chunk;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn keeps_output_and_exit_code_after_the_process_ends() {
        let dir = tempfile::tempdir().unwrap();
        let terminals = Terminals::new();
        let id = start(&terminals, sh("echo hi; exit 3"), dir.path());
        let chunk = wait_for(&terminals, id, |c| c.exit.is_some());
        assert_eq!(chunk.exit, Some(Some(3)));
        assert!(String::from_utf8_lossy(&chunk.bytes).contains("hi"));
        assert_eq!(terminals.read(id, chunk.next).unwrap().bytes, b"");
        assert_eq!(terminals.info(id).unwrap().exit, Some(Some(3)));
    }

    #[test]
    fn subscribers_get_the_scrollback_then_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let terminals = Terminals::new();
        let id = start(&terminals, CommandBuilder::new("/bin/cat"), dir.path());
        terminals.write(id, b"one\n").unwrap();
        wait_for(&terminals, id, |c| String::from_utf8_lossy(&c.bytes).matches("one").count() >= 2);

        let (tx, rx) = mpsc::channel();
        terminals.subscribe(id, Box::new(move |event| tx.send(event).is_ok())).unwrap();
        terminals.resize(id, 120, 40).unwrap();
        terminals.write(id, b"two\n").unwrap();
        terminals.kill(id);

        let mut text = String::new();
        let mut exited = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(5)) {
            match event {
                Event::Output(bytes) => text.push_str(&String::from_utf8_lossy(&bytes)),
                Event::Exit(_) => {
                    exited = true;
                    break;
                }
            }
        }
        assert!(text.starts_with("one"), "{text:?}");
        assert!(text.contains("two"));
        assert!(exited);
        assert!(matches!(terminals.write(id, b"x"), Err(Error::Closed(_))));
    }

    #[test]
    fn kill_where_spares_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let terminals = Terminals::new();
        let mine = start(&terminals, CommandBuilder::new("/bin/cat"), dir.path());
        let spawn = Spawn {
            cwd: dir.path(),
            cols: 80,
            rows: 24,
            program: Program::Shell,
            owner: Some("chat".into()),
            title: "agent".into(),
        };
        let agents = terminals.spawn_command(CommandBuilder::new("/bin/cat"), spawn).unwrap();
        terminals.kill_where(|info| info.owner.is_none());
        assert!(terminals.info(mine).is_err());
        assert_eq!(terminals.list().iter().map(|i| i.id).collect::<Vec<_>>(), [agents]);
    }

    #[test]
    fn plain_text_drops_colours_and_redrawn_lines() {
        assert_eq!(plain_text(b"\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\r\ndone"), "ok\n100%\ndone");
    }
}
