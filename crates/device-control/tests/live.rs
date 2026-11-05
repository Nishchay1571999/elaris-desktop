//! Against real devices: `cargo test -p device-control -- --ignored --test-threads=1`.
//! Needs one Android emulator or iOS simulator running (iOS also needs AXe).
//! Only looks, and presses Home.

use device_control::{DeviceControl, Request, Step};

#[test]
#[ignore = "needs a running emulator or simulator"]
fn reads_the_running_device_without_touching_it() {
    let control = DeviceControl::default();
    let screen = control.handle(Request::Screen { device: None, image: false, max_elements: None }).expect("screen");
    println!("{}\n({} bytes)", screen.text, screen.text.len());
    assert!(screen.image.is_none());

    let logs = control
        .handle(Request::Logs { device: None, app: None, grep: None, since: Some(120), lines: Some(15), level: None })
        .expect("logs");
    println!("{}\n({} bytes)", logs.text, logs.text.len());
}

#[test]
#[ignore = "needs a running emulator or simulator"]
fn lists_reads_and_acts_on_the_running_device() {
    let control = DeviceControl::default();

    let devices = control.handle(Request::Devices).expect("devices").text;
    assert!(devices.starts_with("Running:"), "{devices}");

    let screen = control
        .handle(Request::Screen { device: None, image: true, max_elements: None })
        .expect("screen");
    assert!(screen.text.contains("elements"), "{}", screen.text);
    let jpeg = screen.image.expect("a screenshot");
    assert_eq!(&jpeg[..2], [0xFF, 0xD8], "not a JPEG");

    let act = control
        .handle(Request::Act {
            device: None,
            steps: vec![Step::Key { key: "home".into() }, Step::Wait { ms: 300 }],
            observe: Default::default(),
            max_elements: Some(20),
        })
        .expect("act");
    assert!(act.text.starts_with("1. Pressed home"), "{}", act.text);
}
