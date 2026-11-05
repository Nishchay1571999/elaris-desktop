//! Against the real display: `cargo test -p desktop-control -- --ignored`.
//! Needs the Screen Recording permission for whatever runs the tests (e.g.
//! your terminal app). Only looks; it never clicks or types.

#[test]
#[ignore = "takes a real screenshot"]
fn takes_a_screenshot_that_fits_the_frame() {
    let shot = desktop_control::screenshot().expect("screenshot");
    let frame = shot.frame;
    assert!(frame.width <= desktop_control::MAX_WIDTH && frame.height <= desktop_control::MAX_HEIGHT);
    assert_eq!(&shot.jpeg[..2], [0xFF, 0xD8], "not a JPEG");

    let (x, y) = desktop_control::cursor().expect("cursor");
    assert!(x >= 0 && y >= 0, "pointer at ({x}, {y})");
}
