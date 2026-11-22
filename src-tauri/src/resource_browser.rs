//! Paginated folder navigation over the immutable project resource index.
//! The webview never receives the entire (possibly 250k item) tree.
use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::StudioError;
use crate::project::ResourceEntry;

const MAX_BROWSER_PAGE: usize = 100;

#[derive(Debug, Serialize)]
pub struct ResourceBrowserEntry {
    pub path: String,
    pub name: String,
    /// folder, yaml, ftl, or rsi
    pub kind: &'static str,
    /// Number of indexed leaf resources below a folder; 0 for files.
    pub descendant_resources: usize,
}

#[derive(Debug, Serialize)]
pub struct ResourceBrowserPage {
    pub directory: String,
    pub parent: Option<String>,
    pub total: usize,
    pub items: Vec<ResourceBrowserEntry>,
}

fn normalized_directory(raw: &str) -> Result<&str, StudioError> {
    let dir = if raw.is_empty() { "Resources" } else { raw };
    if dir.len() > 1024
        || (dir != "Resources" && !dir.starts_with("Resources/"))
        || dir.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || dir.contains('\\')
        || dir.bytes().any(|byte| byte == 0 || byte == b':')
    {
        return Err(StudioError::new(
            "RESOURCE_BROWSER_PATH_INVALID",
            "Папка находится вне индекса ресурсов либо её путь некорректен.",
            "Откройте папку через навигацию в Studio.",
        ));
    }
    Ok(dir)
}

pub fn browse(
    resources: &[ResourceEntry],
    directory: &str,
    offset: usize,
    limit: usize,
) -> Result<ResourceBrowserPage, StudioError> {
    let directory = normalized_directory(directory)?;
    let root = format!("{directory}/");
    let start = resources.partition_point(|item| item.path.as_str() < root.as_str());
    let mut folders: BTreeMap<String, usize> = BTreeMap::new();
    let mut leafs = Vec::new();

    for item in resources[start..].iter() {
        let Some(rest) = item.path.strip_prefix(&root) else {
            break;
        };
        if let Some((folder, _)) = rest.split_once('/') {
            *folders.entry(folder.into()).or_default() += 1;
        } else if !rest.is_empty() {
            leafs.push(ResourceBrowserEntry {
                path: item.path.clone(),
                name: rest.into(),
                kind: item.kind,
                descendant_resources: 0,
            });
        }
    }

    let folder_count = folders.len();
    let total = folder_count + leafs.len();
    let count = limit.clamp(1, MAX_BROWSER_PAGE);
    let end = offset.saturating_add(count);
    let items = folders
        .into_iter()
        .map(|(name, descendant_resources)| ResourceBrowserEntry {
            path: format!("{directory}/{name}"),
            name,
            kind: "folder",
            descendant_resources,
        })
        .chain(leafs)
        .enumerate()
        .filter_map(|(index, item)| (index >= offset && index < end).then_some(item))
        .collect();
    let parent = directory.rsplit_once('/').map(|(head, _)| head.to_owned());

    Ok(ResourceBrowserPage {
        directory: directory.into(),
        parent,
        total,
        items,
    })
}
