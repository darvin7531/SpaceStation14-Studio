//! Bounded, read-only monitoring of resources already open in the editor.
//! An external edit is never accepted as the new baseline automatically.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::StudioError;
use crate::project::ProjectIndex;

const MAX_OPEN_REVISIONS: usize = 32;
const MAX_SCANNED_BYTES: usize = 28 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct OpenRevision {
    pub path: String,
    pub expected_revision: String,
}

#[derive(Debug, Serialize)]
pub struct ResourceDrift {
    pub path: String,
    /// "changed" or "unavailable". Unchanged resources are omitted.
    pub status: &'static str,
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ResourceDriftReport {
    pub checked: usize,
    pub skipped: usize,
    pub items: Vec<ResourceDrift>,
}

/// Inspect only indexed paths through ProjectIndex::read_resource, which
/// enforces the project-root boundary and a 4 MiB per-file read limit.
pub fn probe(
    project: &ProjectIndex,
    opened: &[OpenRevision],
) -> Result<ResourceDriftReport, StudioError> {
    if opened.len() > MAX_OPEN_REVISIONS {
        return Err(StudioError::new(
            "RESOURCE_PROBE_TOO_MANY",
            "Слишком много открытых ресурсов для проверки изменений.",
            "Закройте лишние вкладки и повторите проверку.",
        ));
    }
    let mut unique = HashSet::new();
    for item in opened {
        if !unique.insert(item.path.as_str())
            || item.expected_revision.len() != 64
            || !item
                .expected_revision
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err(StudioError::new(
                "RESOURCE_PROBE_INPUT_INVALID",
                "Указаны дубликаты файлов либо некорректные ревизии.",
                "Проверьте открытые вкладки и повторите проверку.",
            ));
        }
    }

    let mut report = ResourceDriftReport {
        checked: 0,
        skipped: 0,
        items: Vec::new(),
    };
    let mut read_bytes = 0usize;
    for (index, item) in opened.iter().enumerate() {
        if read_bytes >= MAX_SCANNED_BYTES {
            report.skipped = opened.len() - index;
            break;
        }
        match project.read_resource(&item.path) {
            Ok(document) => {
                read_bytes += document.bytes;
                report.checked += 1;
                if document.revision != item.expected_revision {
                    report.items.push(ResourceDrift {
                        path: item.path.clone(),
                        status: "changed",
                        error_code: None,
                    });
                }
            }
            Err(error) if error.code == "RESOURCE_NOT_INDEXED" => {
                return Err(StudioError::new(
                    "RESOURCE_PROBE_INPUT_INVALID",
                    "Путь отсутствует в индексе открытого проекта.",
                    "Выберите ресурс из списка файлов Studio.",
                ));
            }
            Err(error) => {
                report.checked += 1;
                report.items.push(ResourceDrift {
                    path: item.path.clone(),
                    status: "unavailable",
                    error_code: Some(error.code.into()),
                });
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-studio-probe-{}-{id}", std::process::id()));
            fs::create_dir_all(root.join("Resources/Prototypes")).unwrap();
            Self(root)
        }

        fn write(&self, path: &str, content: &str) {
            let target = self.0.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, content).unwrap();
        }

        fn index(&self) -> ProjectIndex {
            ProjectIndex::open(self.0.to_str().unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_modified_and_deleted_sources_without_writing_anything() {
        let fx = Fixture::new();
        let yaml = "Resources/Prototypes/test.yml";
        let ftl = "Resources/Locale/en-US/test.ftl";
        let rsi = "Resources/Textures/test.rsi";
        fx.write(yaml, "- type: entity\n  id: Old\n");
        fx.write(ftl, "name = Old\n");
        fx.write(&format!("{rsi}/meta.json"), r#"{"version":1,"states":[]}"#);
        let index = fx.index();
        let opened: Vec<OpenRevision> = [yaml, ftl, rsi]
            .iter()
            .map(|path| OpenRevision {
                path: (*path).into(),
                expected_revision: index.read_resource(path).unwrap().revision,
            })
            .collect();
        let original = probe(&index, &opened).unwrap();
        assert_eq!(original.checked, 3);
        assert!(original.items.is_empty());

        fx.write(yaml, "- type: entity\n  id: New\n");
        fs::remove_file(fx.0.join(ftl)).unwrap();
        let changed = probe(&index, &opened).unwrap();
        assert_eq!(changed.checked, 3);
        assert_eq!(changed.items.len(), 2);
        assert!(changed
            .items
            .iter()
            .any(|item| item.path == yaml && item.status == "changed"));
        assert!(changed.items.iter().any(|item| item.path == ftl
            && item.status == "unavailable"
            && item.error_code.is_some()));
        assert!(changed.items.iter().all(|item| item.path != rsi));
        assert_eq!(
            fs::read_to_string(fx.0.join(yaml)).unwrap(),
            "- type: entity\n  id: New\n"
        );
    }

    #[test]
    fn rejects_repeated_unindexed_and_invalid_revision_inputs() {
        let fx = Fixture::new();
        let path = "Resources/Prototypes/test.yml";
        fx.write(path, "- type: entity\n  id: Example\n");
        let index = fx.index();
        let revision = index.read_resource(path).unwrap().revision;
        assert_eq!(
            probe(
                &index,
                &[OpenRevision {
                    path: "../outside.yml".into(),
                    expected_revision: revision.clone(),
                }]
            )
            .unwrap_err()
            .code,
            "RESOURCE_PROBE_INPUT_INVALID"
        );
        assert_eq!(
            probe(
                &index,
                &[OpenRevision {
                    path: path.into(),
                    expected_revision: "invalid".into(),
                }]
            )
            .unwrap_err()
            .code,
            "RESOURCE_PROBE_INPUT_INVALID"
        );
        assert_eq!(
            probe(
                &index,
                &[
                    OpenRevision {
                        path: path.into(),
                        expected_revision: revision.clone(),
                    },
                    OpenRevision {
                        path: path.into(),
                        expected_revision: revision,
                    },
                ]
            )
            .unwrap_err()
            .code,
            "RESOURCE_PROBE_INPUT_INVALID"
        );
    }
}
