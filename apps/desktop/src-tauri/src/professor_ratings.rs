//! An explicit boundary for licensed professor ratings. No network transport ships here.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfessorRatingSummary {
    pub value: f32,
    pub review_count: u32,
    pub source_url: String,
    pub updated_at: String,
    pub bias_warning: String,
}

pub trait ProfessorRatingProvider {
    fn rating_for(&self, professor: &crate::ProfessorRecord) -> Option<ProfessorRatingSummary>;
}

pub struct DisabledProfessorRatingProvider;

impl ProfessorRatingProvider for DisabledProfessorRatingProvider {
    fn rating_for(&self, _professor: &crate::ProfessorRecord) -> Option<ProfessorRatingSummary> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratings_require_an_authorized_provider() {
        let professor = crate::ProfessorRecord {
            id: "catalog:example".into(), name: "Jane Doe".into(), institution_id: "104151".into(),
            course_id: "course".into(), course_code: "CSE 240".into(), email: String::new(),
            office_location: String::new(), office_hours: String::new(), rating: None,
            source: crate::ProfessorSourceSnapshot {
                kind: "official_course_catalog".into(), label: "Official class search".into(),
                url: "https://catalog.apps.asu.edu".into(), term_label: "Fall".into(),
                campus_id: "tempe".into(), section_numbers: vec!["12345".into()], captured_at: None,
            },
        };
        assert!(DisabledProfessorRatingProvider.rating_for(&professor).is_none());
    }
}
