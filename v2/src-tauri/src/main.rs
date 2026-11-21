#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = ss14_studio_v2_lib::run() {
        eprintln!(
            "Не удалось запустить SS14 Studio 2.0: {error}\n\
             Проверьте системные зависимости Tauri и доступность графического окружения."
        );
        std::process::exit(1);
    }
}
