use serde::Serialize;

/// Stable and user-readable error contract. Technical details may be disclosed
/// in the collapsible diagnostics section, never shown as the main message.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StudioError {
    pub code: &'static str,
    pub message: String,
    pub hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl StudioError {
    pub fn new(code: &'static str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: hint.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

pub fn interrupted(details: impl std::fmt::Display) -> StudioError {
    StudioError::new(
        "TASK_INTERRUPTED",
        "Операция была неожиданно прервана.",
        "Повторите действие. Если ошибка повторится, приложите диагностические сведения.",
    )
    .with_details(details.to_string())
}

pub fn internal_lock() -> StudioError {
    StudioError::new(
        "STATE_UNAVAILABLE",
        "Внутреннее состояние Studio временно недоступно.",
        "Перезапустите приложение. Открытые исходники проекта не изменялись.",
    )
}
