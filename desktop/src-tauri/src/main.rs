// Prevents an additional console window on Windows in release builds.
// Desktop entry point only: all shared logic lives in lib.rs, which mobile
// builds compile as a library and load through the platform frameworks.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ankilearning_desktop_lib::run();
}
