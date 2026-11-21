#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = ss14_studio_lib::run() {
        eprintln!(
            "Не удалось запустить SS14 Studio: {error}\n\
             Проверьте наличие системных библиотек Tauri и графического окружения."
        );
        std::process::exit(1);
    }
}
