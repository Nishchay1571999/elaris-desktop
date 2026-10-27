//! Talks to a real server. Opt in with `ELARIS_LIVE_LSP=1`; needs rust-analyzer.

use std::path::Path;

use code_intelligence::{CodeIntelligence, ServerState};

#[tokio::test(flavor = "multi_thread")]
async fn rust_analyzer_colours_this_crate() {
    if std::env::var_os("ELARIS_LIVE_LSP").is_none() {
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let ci = CodeIntelligence::new(data.path());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/servers.rs");
    let text = std::fs::read_to_string(&file).unwrap();

    let mut first = ci.highlights(root, &file, &text).await;
    println!("{:?}", first.status);
    if matches!(first.status.state, ServerState::Missing | ServerState::Failed) {
        // Exercises the Neovim + Mason install path, into the temp folder.
        let status = ci.install(root, &file).await.expect("Mason installs rust-analyzer");
        println!("after install: {status:?}");
        first = ci.highlights(root, &file, &text).await;
        println!("{:?}", first.status);
    }
    assert!(matches!(first.status.state, ServerState::Running), "{:?}", first.status);
    let tokens = first.tokens.expect("rust-analyzer sends semantic tokens");
    assert!(tokens.data.len() >= 5 * 50, "only {} numbers", tokens.data.len());
    assert!(tokens.types.iter().any(|t| t == "keyword"));
}
