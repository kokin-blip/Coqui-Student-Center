# Coqui Student Center product contract

Coqui is a private, local-first academic workspace that helps a student decide what to do next, understand why, and keep the evidence behind that decision. It is not a replacement LMS and it never submits schoolwork or applications on a student's behalf.

## Product promises

- Useful offline: planning, review, study artifacts, scholarship tracking, and drafts remain available without a network.
- Review before write: imports and remote changes become candidates or diffs before they alter approved records.
- Explainable decisions: planning and scholarship matches show the inputs that produced them.
- Private by default: secrets use the OS credential vault; academic records, scholarship records, and drafts use encrypted local storage and backups.
- Honest automation: partial success is visible, unsupported data is isolated, and no UI claims completion until the persisted result can be observed.

## Primary areas

Today, Calendar, Work, Courses, Study, and Scholarships are student workspaces. Integrations, sync, security, backup, appearance, updates, and advanced controls are administrative settings.

Scholarships has four durable workflows: Discover opportunities from allowlisted public sources, Save and verify them, track Applications, and develop prompt-specific Writing with version history. Coqui never infers sensitive identity traits, fabricates experiences, applies text silently, or submits an application.

## Release standard

A headline feature is complete only when a student can reach it, complete it with keyboard and pointer input, see failures and partial success, and reopen the stored result. All releases require contract, TypeScript, Rust, accessibility, responsive, backup, migration, and secret-redaction checks appropriate to the changed surface.
