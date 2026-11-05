//! Finding a project's logo: its favicon or `logo.*` file, whichever the repo has.

use std::fs;
use std::path::{Path, PathBuf};

/// Folders a project keeps its icon in, most specific first.
const DIRS: &[&str] = &["", "public", "static", "assets", "app", "src/app", "src", "docs", ".github", "resources", "images"];

/// File names that are a project's icon. Favicons and logos count the same:
/// within a folder, the first name here that exists wins.
const NAMES: &[&str] = &[
    "favicon.svg",
    "logo.svg",
    "icon.svg",
    "favicon.png",
    "logo.png",
    "icon.png",
    "apple-touch-icon.png",
    "favicon.ico",
    "logo.jpg",
    "logo.webp",
];

/// Android resource folders: a React Native or Expo app's `android/`, or a native app's own module.
const ANDROID_RES: &[&str] = &["android/app/src/main/res", "app/src/main/res"];

/// Launcher icon densities, sharpest first.
const ANDROID_DENSITIES: &[&str] = &["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi"];

/// Launcher icon files. The full icon, not an adaptive icon's foreground or
/// background layer, which are XML or half an image.
const ANDROID_NAMES: &[&str] = &["ic_launcher.png", "ic_launcher.webp", "ic_launcher_round.png", "ic_launcher_round.webp"];

/// Monorepo folders whose apps and packages may carry the icon instead.
const NESTED: &[&str] = &["apps", "packages"];

/// Logos bigger than this are skipped: they're artwork, not an icon (Elaris's own `logo.png` is ~700 KB).
pub const MAX_LOGO_BYTES: u64 = 2 * 1024 * 1024;

/// The project's icon file, if it has one: a favicon or a `logo.*`, at the top
/// or in a usual assets folder, else an Android launcher icon, then the same
/// in a monorepo's `apps/*` and `packages/*`.
pub fn find_logo(root: &Path) -> Option<PathBuf> {
    find_in(root).or_else(|| {
        NESTED.iter().find_map(|nested| {
            let mut children: Vec<_> = fs::read_dir(root.join(nested)).ok()?.flatten().map(|e| e.path()).collect();
            children.sort();
            children.iter().filter(|p| p.is_dir()).find_map(|child| find_in(child))
        })
    })
}

fn find_in(base: &Path) -> Option<PathBuf> {
    DIRS.iter()
        .find_map(|dir| NAMES.iter().map(|name| base.join(dir).join(name)).find(|path| is_icon(path)))
        .or_else(|| find_android_icon(base))
}

fn find_android_icon(base: &Path) -> Option<PathBuf> {
    ANDROID_RES.iter().find_map(|res| {
        ANDROID_DENSITIES.iter().find_map(|density| {
            let dir = base.join(res).join(format!("mipmap-{density}"));
            ANDROID_NAMES.iter().map(|name| dir.join(name)).find(|path| is_icon(path))
        })
    })
}

fn is_icon(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0 && meta.len() <= MAX_LOGO_BYTES)
}

/// The image type of `path` by extension, for a `data:` URL; `None` if it isn't an image we show.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"img").unwrap();
    }

    #[test]
    fn finds_a_root_logo_png() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "logo.png");
        assert_eq!(find_logo(dir.path()), Some(dir.path().join("logo.png")));
    }

    #[test]
    fn a_favicon_counts_like_a_logo() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "public/favicon.ico");
        assert_eq!(find_logo(dir.path()), Some(dir.path().join("public/favicon.ico")));
    }

    #[test]
    fn the_top_folder_comes_before_assets_folders() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "public/favicon.svg");
        touch(dir.path(), "logo.png");
        assert_eq!(find_logo(dir.path()), Some(dir.path().join("logo.png")));
    }

    #[test]
    fn looks_inside_monorepo_apps() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "apps/web/public/favicon.ico");
        assert_eq!(find_logo(dir.path()), Some(dir.path().join("apps/web/public/favicon.ico")));
    }

    #[test]
    fn finds_a_react_native_launcher_icon_at_the_sharpest_density() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "android/app/src/main/res/mipmap-mdpi/ic_launcher.webp");
        touch(dir.path(), "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.webp");
        touch(dir.path(), "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp");
        assert_eq!(
            find_logo(dir.path()),
            Some(dir.path().join("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp"))
        );
    }

    #[test]
    fn a_logo_file_comes_before_the_launcher_icon() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png");
        touch(dir.path(), "assets/logo.png");
        assert_eq!(find_logo(dir.path()), Some(dir.path().join("assets/logo.png")));
    }

    #[test]
    fn none_without_an_icon() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "README.md");
        assert_eq!(find_logo(dir.path()), None);
    }
}
