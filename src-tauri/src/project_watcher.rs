//! Native change events invalidate the immutable workspace snapshot.
//! Frontend debounces events and uses existing safe draft-aware refresh.
use crate::error::StudioError;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct ProjectWatcher(Mutex<Option<RecommendedWatcher>>);

const MAX_EVENT_PATHS: usize = 256;

#[derive(Clone, Serialize)]
struct ProjectChange {
    project_root: String,
    paths: Vec<String>,
    full: bool,
}

#[derive(Default)]
struct ChangeBatch {
    paths: BTreeSet<String>,
    full: bool,
}

impl ChangeBatch {
    fn merge(&mut self, root: &Path, event: notify::Result<notify::Event>) {
        let Ok(event) = event else {
            self.full = true;
            return;
        };
        if !relevant(&event.kind) {
            return;
        }
        if event.paths.is_empty() {
            self.full = true;
        }
        for absolute in &event.paths {
            let Some(relative) = absolute.strip_prefix(root).ok().and_then(Path::to_str) else {
                self.full = true;
                break;
            };
            let normalized = relative.replace('\\', "/");
            if normalized.is_empty() || normalized.len() > 1024 {
                self.full = true;
                break;
            }
            self.paths.insert(normalized);
            if self.paths.len() > MAX_EVENT_PATHS {
                self.full = true;
                self.paths.clear();
                break;
            }
        }
    }
}

fn relevant(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    )
}

impl ProjectWatcher {
    pub fn replace(&self, app: &AppHandle, root: &Path) -> Result<(), StudioError> {
        let mut active = self.0.lock().map_err(|_| {
            StudioError::new(
                "PROJECT_WATCH_LOCK_FAILED",
                "Не удалось переключить наблюдение за проектом.",
                "Обновляйте индекс вручную или перезапустите Studio.",
            )
        })?;
        *active = None; // Release old inotify handles on project switch.

        let project_root = root.to_string_lossy().into_owned();
        let watcher_root = root.to_path_buf();
        let batch = Arc::new(Mutex::new(ChangeBatch::default()));
        let scheduled = Arc::new(AtomicBool::new(false));
        let app = app.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.as_ref().is_ok_and(|item| !relevant(&item.kind)) {
                    return;
                }
                let Ok(mut changes) = batch.lock() else {
                    return;
                };
                changes.merge(&watcher_root, event);
                // Keep every path from a burst. A throttle that discards later
                // events silently misses new and deleted files.
                if !scheduled.swap(true, Ordering::SeqCst) {
                    let pending = Arc::clone(&batch);
                    let flag = Arc::clone(&scheduled);
                    let app = app.clone();
                    let root = project_root.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(350));
                        let Ok(mut pending) = pending.lock() else {
                            return;
                        };
                        let collected = std::mem::take(&mut *pending);
                        // Clear the scheduling flag while holding the same lock:
                        // any event after this point schedules another flush.
                        flag.store(false, Ordering::SeqCst);
                        drop(pending);
                        let _ = app.emit(
                            "studio:project-changed",
                            ProjectChange {
                                project_root: root,
                                paths: collected.paths.into_iter().collect(),
                                full: collected.full,
                            },
                        );
                    });
                }
            })
            .map_err(|error| {
                StudioError::new(
                    "PROJECT_WATCH_INIT_FAILED",
                    "Не удалось запустить наблюдение за изменениями.",
                    "Используйте ручное обновление индекса.",
                )
                .with_details(error.to_string())
            })?;

        let mut scopes = 0;
        // Avoid observing .git, target, node_modules, generated files.
        for relative in [
            "Resources/Prototypes",
            "Resources/Textures",
            "Resources/Locale",
        ] {
            let folder = root.join(relative);
            if !folder.is_dir() {
                continue;
            }
            watcher
                .watch(&folder, RecursiveMode::Recursive)
                .map_err(|error| {
                    StudioError::new(
                        "PROJECT_WATCH_SCOPE_FAILED",
                        "Не удалось наблюдать за ресурсами проекта.",
                        "Проверьте права доступа или лимиты inotify; обновляйте индекс вручную.",
                    )
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
                watcher
                    .watch(&entry.path(), RecursiveMode::Recursive)
                    .map_err(|error| {
                        StudioError::new(
                            "PROJECT_WATCH_CSHARP_FAILED",
                            "Не удалось наблюдать за C#-исходниками.",
                            "Используйте ручное обновление индекса.",
                        )
                        .with_details(format!("{}: {error}", entry.path().display()))
                    })?;
                scopes += 1;
            }
        }
        if scopes == 0 {
            return Err(StudioError::new(
                "PROJECT_WATCH_NO_SCOPES",
                "Нет каталогов для наблюдения.",
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
    #[test]
    fn batch_keeps_all_paths_from_notify_burst() {
        use notify::event::ModifyKind;
        let root = Path::new("/tmp/studio-project");
        let mut batch = ChangeBatch::default();
        for name in ["one.yml", "two.yml", "one.yml"] {
            batch.merge(
                root,
                Ok(notify::Event::new(EventKind::Modify(ModifyKind::Any))
                    .add_path(root.join("Resources/Prototypes").join(name))),
            );
        }
        assert!(!batch.full);
        assert_eq!(batch.paths.len(), 2);
        assert!(batch.paths.contains("Resources/Prototypes/one.yml"));
        assert!(batch.paths.contains("Resources/Prototypes/two.yml"));
    }

    #[test]
    fn missing_or_external_paths_require_full_scan() {
        use notify::event::CreateKind;
        let root = Path::new("/tmp/studio-project");
        let mut batch = ChangeBatch::default();
        batch.merge(
            root,
            Ok(notify::Event::new(EventKind::Create(CreateKind::Any))),
        );
        assert!(batch.full);
        let mut outside = ChangeBatch::default();
        outside.merge(
            root,
            Ok(notify::Event::new(EventKind::Create(CreateKind::Any))
                .add_path(Path::new("/tmp/outside").to_path_buf())),
        );
        assert!(outside.full);
    }
}
