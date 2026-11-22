//! Native change events invalidate the immutable workspace snapshot.
//! Frontend debounces events and uses existing safe draft-aware refresh.
use std::{fs, path::Path, sync::{Arc, Mutex}, time::{Duration, Instant}};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use crate::error::StudioError;

#[derive(Default)]
pub struct ProjectWatcher(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
struct ProjectChange { project_root: String }

fn relevant(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Any | EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_))
}

impl ProjectWatcher {
    pub fn replace(&self, app: &AppHandle, root: &Path) -> Result<(), StudioError> {
        let mut active = self.0.lock().map_err(|_| StudioError::new(
            "PROJECT_WATCH_LOCK_FAILED", "Не удалось переключить наблюдение за проектом.",
            "Обновляйте индекс вручную или перезапустите Studio.",
        ))?;
        *active = None; // Release old inotify handles on project switch.

        let signal = ProjectChange { project_root: root.to_string_lossy().into_owned() };
        let gate = Arc::new(Mutex::new(None::<Instant>));
        let app = app.clone();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if !relevant(&event.kind) { return; }
            let Ok(mut last) = gate.lock() else { return };
            let now = Instant::now();
            if last.is_some_and(|previous| now.duration_since(previous) < Duration::from_millis(350)) {
                return;
            }
            *last = Some(now);
            let _ = app.emit("studio:project-changed", signal.clone());
        }).map_err(|error| StudioError::new(
            "PROJECT_WATCH_INIT_FAILED", "Не удалось запустить наблюдение за изменениями.",
            "Используйте ручное обновление индекса.",
        ).with_details(error.to_string()))?;

        let mut scopes = 0;
        // Avoid observing .git, target, node_modules, generated files.
        for relative in ["Resources/Prototypes", "Resources/Textures", "Resources/Locale"] {
            let folder = root.join(relative);
            if !folder.is_dir() { continue; }
            watcher.watch(&folder, RecursiveMode::Recursive).map_err(|error| {
                StudioError::new("PROJECT_WATCH_SCOPE_FAILED",
                    "Не удалось наблюдать за ресурсами проекта.",
                    "Проверьте права доступа или лимиты inotify; обновляйте индекс вручную.")
                    .with_details(format!("{}: {error}", folder.display()))
            })?;
            scopes += 1;
        }
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten().take(256) {
                let name = entry.file_name();
                if !name.to_string_lossy().starts_with("Content.") || !entry.path().is_dir() {
                    continue;
                }
                watcher.watch(&entry.path(), RecursiveMode::Recursive).map_err(|error| {
                    StudioError::new("PROJECT_WATCH_CSHARP_FAILED",
                        "Не удалось наблюдать за C#-исходниками.",
                        "Используйте ручное обновление индекса.")
                        .with_details(format!("{}: {error}", entry.path().display()))
                })?;
                scopes += 1;
            }
        }
        if scopes == 0 {
            return Err(StudioError::new(
                "PROJECT_WATCH_NO_SCOPES", "Нет каталогов для наблюдения.",
                "Проверьте структуру Resources и обновляйте индекс вручную.",
            ));
        }
        *active = Some(watcher);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ignores_read_events_but_handles_content_changes() {
        use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};
        assert!(relevant(&EventKind::Create(CreateKind::Any)));
        assert!(relevant(&EventKind::Modify(ModifyKind::Any)));
        assert!(relevant(&EventKind::Remove(RemoveKind::Any)));
        assert!(!relevant(&EventKind::Access(AccessKind::Any)));
        assert!(!relevant(&EventKind::Other));
    }
}
