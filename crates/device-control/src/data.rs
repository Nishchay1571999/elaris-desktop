//! Showing files from an app's sandbox: text filtered and clipped, and SQLite
//! databases queried from a private copy, so the app's own file is never
//! touched.

use regex::Regex;

use crate::exec::temp_path;
use crate::ui::clip;
use crate::{Error, Result};

const LINE_MAX: usize = 300;
const TEXT_MAX: usize = 20_000;
const ROWS_MAX: usize = 100;
const VALUE_MAX: usize = 200;

/// A file's contents for the agent: its lines (those matching `grep`), or a
/// note saying what it is when it isn't text.
pub fn render_file(bytes: &[u8], grep: Option<&Regex>) -> String {
    if bytes.starts_with(b"SQLite format 3\0") {
        return format!("A SQLite database ({} bytes). Query it with the `sql` action.", bytes.len());
    }
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return format!("A binary file ({} bytes).", bytes.len());
    }
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let mut shown = 0;
    let mut total = 0;
    for line in text.lines() {
        if grep.is_some_and(|re| !re.is_match(line)) {
            continue;
        }
        total += 1;
        if out.len() < TEXT_MAX {
            out.push_str(&clip(line, LINE_MAX));
            out.push('\n');
            shown += 1;
        }
    }
    if total == 0 {
        return match grep {
            Some(re) => format!("No lines match /{re}/ ({} bytes).", bytes.len()),
            None => "The file is empty.".into(),
        };
    }
    if shown < total {
        out.push_str(&format!("… {} more lines; narrow it with grep.", total - shown));
    }
    out.trim_end().to_string()
}

/// Runs `sql` against a copy of a database (and its write-ahead log, which
/// holds the newest rows until SQLite folds them in), formatted like
/// `sqlite3 -header`: one `|`-separated line per row.
pub fn query(db: &[u8], wal: Option<&[u8]>, sql: &str) -> Result<String> {
    let path = temp_path("db");
    let wal_path = path.with_extension("db-wal");
    let result = (|| {
        std::fs::write(&path, db)?;
        if let Some(wal) = wal.filter(|w| !w.is_empty()) {
            std::fs::write(&wal_path, wal)?;
        }
        let conn = rusqlite::Connection::open(&path).map_err(sql_error)?;
        let mut statement = conn.prepare(sql).map_err(sql_error)?;
        let columns: Vec<String> = statement.column_names().map(str::to_string).collect();
        let width = columns.len();
        let mut rows = statement.query([]).map_err(sql_error)?;
        let mut out = vec![columns.join("|")];
        let mut count = 0;
        while let Some(row) = rows.next().map_err(sql_error)? {
            count += 1;
            if count > ROWS_MAX {
                continue;
            }
            let cells: Vec<String> = (0..width)
                .map(|i| match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) | Err(_) => String::new(),
                    Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
                    Ok(rusqlite::types::ValueRef::Real(f)) => f.to_string(),
                    Ok(rusqlite::types::ValueRef::Text(t)) => clip(&String::from_utf8_lossy(t), VALUE_MAX),
                    Ok(rusqlite::types::ValueRef::Blob(b)) => format!("<{} bytes>", b.len()),
                })
                .collect();
            out.push(cells.join("|"));
        }
        if width == 0 {
            return Ok("Done; the statement returns no rows.".to_string());
        }
        if count > ROWS_MAX {
            out.push(format!("… {} more rows; add a LIMIT or WHERE.", count - ROWS_MAX));
        } else {
            out.push(format!("({count} rows)"));
        }
        Ok(out.join("\n"))
    })();
    for p in [&path, &wal_path, &path.with_extension("db-shm")] {
        let _ = std::fs::remove_file(p);
    }
    result
}

fn sql_error(e: rusqlite::Error) -> Error {
    Error::Invalid(format!("SQLite: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_filtered_and_binary_is_described() {
        let prefs = b"<map>\n  <int name=\"comms_last_ts\" value=\"17\" />\n  <string name=\"deviceId\">abc</string>\n</map>";
        let re = Regex::new("(?i)comms").unwrap();
        assert_eq!(render_file(prefs, Some(&re)), "  <int name=\"comms_last_ts\" value=\"17\" />");
        assert_eq!(render_file(b"\x00\x01\x02", None), "A binary file (3 bytes).");
        assert!(render_file(b"SQLite format 3\0rest", None).starts_with("A SQLite database"));
    }

    #[test]
    fn queries_run_on_a_copy() {
        let path = temp_path("db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "create table userEventLogs(eventName text, count integer);
                 insert into userEventLogs values ('app_opened', 2), ('call_log_row_tapped', 8);",
            )
            .unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        let out = query(&bytes, None, "select eventName, count from userEventLogs order by count desc").unwrap();
        assert_eq!(out, "eventName|count\ncall_log_row_tapped|8\napp_opened|2\n(2 rows)");
        assert!(query(&bytes, None, "select nope from nowhere").is_err());
    }
}
