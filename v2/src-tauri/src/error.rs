use serde::Serialize;

/// Stable, serializable error contract for the frontend.
/// "message" is readable without technical knowledge, "code" is for reports.
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
