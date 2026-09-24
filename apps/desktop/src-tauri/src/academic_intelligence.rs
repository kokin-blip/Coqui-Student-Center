use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskClassification {
    pub task_kind: String,
    pub priority: i64,
    pub reason_codes: Vec<String>,
    pub suggested_minutes: i64,
}

/// Classifies imported work without sending academic data to a model. The
/// ordered vocabulary intentionally prefers the most consequential assessment
/// term when a title contains more than one keyword.
pub fn classify(title: &str, due_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> TaskClassification {
    let normalized = title.to_ascii_lowercase();
    let (task_kind, base_priority, suggested_minutes, reason) = if normalized.contains("final") {
        ("final", 5, 180, "assessment_final")
    } else if normalized.contains("midterm") {
        ("midterm", 5, 150, "assessment_midterm")
    } else if normalized.contains("exam") {
        ("exam", 5, 150, "assessment_exam")
    } else if normalized.contains("test") {
        ("test", 5, 120, "assessment_test")
    } else if normalized.contains("quiz") {
        ("quiz", 4, 60, "assessment_quiz")
    } else if normalized.contains("project") {
        ("project", 4, 180, "project_work")
    } else if normalized.contains("paper") || normalized.contains("essay") {
        ("paper", 4, 150, "paper_work")
    } else if normalized.contains("lab") {
        ("lab", 3, 90, "lab_work")
    } else if normalized.contains("homework") || normalized.contains("assignment") || normalized.contains("worksheet") {
        ("homework", 3, 60, "homework_work")
    } else if normalized.contains("reading") || normalized.contains("chapter") {
        ("reading", 2, 45, "reading_work")
    } else {
        ("other", 2, 45, "unclassified_work")
    };
    let mut priority = base_priority;
    let mut reason_codes = vec![reason.to_string()];
    if let Some(due) = due_at {
        if due < now {
            priority = priority.max(5);
            reason_codes.push("overdue".into());
        } else if due <= now + Duration::hours(24) {
            priority = priority.max(5);
            reason_codes.push("due_within_24_hours".into());
        } else if due <= now + Duration::days(3) {
            priority = priority.max(4);
            reason_codes.push("due_within_3_days".into());
        }
    }
    TaskClassification { task_kind: task_kind.into(), priority, reason_codes, suggested_minutes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn tests_and_quizzes_receive_assessment_priorities() {
        let now = Utc.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        assert_eq!(classify("Quiz 2", None, now).priority, 4);
        assert_eq!(classify("Practice Exam A for Exam 1", None, now).priority, 5);
        assert_eq!(classify("Final project", None, now).task_kind, "final");
    }

    #[test]
    fn overdue_work_is_raised_and_explained() {
        let now = Utc.with_ymd_and_hms(2026, 9, 22, 12, 0, 0).unwrap();
        let result = classify("Reading quiz", Some(now - Duration::days(1)), now);
        assert_eq!(result.priority, 5);
        assert!(result.reason_codes.contains(&"overdue".to_string()));
    }
}
