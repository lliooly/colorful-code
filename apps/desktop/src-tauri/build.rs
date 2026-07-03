#[cfg(target_os = "macos")]
use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=Info.plist");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=src/macos_speech.m");
    #[cfg(target_os = "macos")]
    build_macos_speech_bridge();
    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn build_macos_speech_bridge() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let library_path = out_dir.join("libcolorful_macos_speech.a");
    let object_path = out_dir.join("macos_speech.o");
    let status = Command::new("xcrun")
        .arg("clang")
        .arg("-fobjc-arc")
        .arg("-ObjC")
        .arg("-c")
        .arg("src/macos_speech.m")
        .arg("-o")
        .arg(&object_path)
        .status()
        .expect("failed to execute xcrun clang for macOS speech bridge");

    if !status.success() {
        panic!("xcrun clang failed while compiling macOS speech bridge");
    }

    let status = Command::new("ar")
        .arg("crus")
        .arg(&library_path)
        .arg(&object_path)
        .status()
        .expect("failed to execute ar for macOS speech bridge");

    if !status.success() {
        panic!("ar failed while archiving macOS speech bridge");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=colorful_macos_speech");
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
}
