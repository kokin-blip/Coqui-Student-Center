use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
    Timelike, Utc,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const GRANULARITY_MINUTES: i64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityRule {
    pub weekday: u32,
    pub starts_at_local: String,
    pub ends_at_local: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannerPreferences {
    pub sleep_start: String,
    pub sleep_end: String,
    pub max_session_minutes: i64,
    pub min_session_minutes: i64,
    pub break_minutes: i64,
    pub transition_minutes: i64,
    pub availability: Vec<AvailabilityRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixedConstraint {
    pub id: String,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub location: String,
    pub travel_before_minutes: i64,
    pub travel_after_minutes: i64,
    pub transition_before_minutes: i64,
    pub transition_after_minutes: i64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTask {
    pub id: String,
    pub title: String,
    pub course_id: Option<String>,
    pub duration_minutes: i64,
    pub due_at: Option<DateTime<Utc>>,
    pub earliest_start: Option<DateTime<Utc>>,
    pub priority: i64,
    pub academic_risk: i64,
    pub energy_demand: String,
    pub location: String,
    pub splittable: bool,
    pub min_session_minutes: i64,
    pub max_session_minutes: i64,
    pub dependencies: Vec<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExistingBlock {
    pub id: String,
    pub task_id: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub completed: bool,
    pub locked: bool,
    pub location: String,
    pub course_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlannerTrigger {
    Initial,
    PreferenceChanged,
    ImportApproved,
    LateWakeUp,
    TaskOverrun,
    LowEnergy,
    CommitmentCanceled,
    DeadlineChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannerSnapshot {
    pub generated_at: DateTime<Utc>,
    pub effective_time: DateTime<Utc>,
    pub horizon_days: i64,
    pub timezone: String,
    pub preferences: PlannerPreferences,
    pub fixed_constraints: Vec<FixedConstraint>,
    pub tasks: Vec<PlannerTask>,
    pub existing_blocks: Vec<ExistingBlock>,
    pub trigger: PlannerTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedBlock {
    pub id: String,
    pub task_id: String,
    pub session_index: i64,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub location: String,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OverloadConflict {
    pub task_id: String,
    pub title: String,
    pub unscheduled_minutes: i64,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySummary {
    pub available_minutes: i64,
    pub fixed_minutes: i64,
    pub planned_minutes: i64,
    pub overload_minutes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanOutcome {
    pub blocks: Vec<PlannedBlock>,
    pub overload_conflicts: Vec<OverloadConflict>,
    pub capacity: CapacitySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RankedAction {
    pub block_id: String,
    pub task_id: String,
    pub concrete_action: String,
    pub duration_minutes: i64,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NextActionOutcome {
    pub action: RankedAction,
    pub alternatives: Vec<RankedAction>,
    pub valid_from: DateTime<Utc>,
    pub valid_until: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct Occupied {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    location: String,
    course_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Score {
    stability: i64,
    energy: i64,
    continuity: i64,
    switching: i64,
    slack: i64,
    start: i64,
}

impl Ord for Score {
    fn cmp(&self, other: &Self) -> Ordering {
        (
            self.stability,
            self.energy,
            self.continuity,
            self.switching,
            self.slack,
            self.start,
        )
            .cmp(&(
                other.stability,
                other.energy,
                other.continuity,
                other.switching,
                other.slack,
                other.start,
            ))
    }
}

impl PartialOrd for Score {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn generate(snapshot: &PlannerSnapshot) -> Result<PlanOutcome, String> {
    let timezone: Tz = snapshot
        .timezone
        .parse()
        .map_err(|_| "planner timezone is invalid")?;
    if !(1..=31).contains(&snapshot.horizon_days) {
        return Err("planner horizon is invalid".into());
    }
    let floor = round_up(
        snapshot.effective_time.max(snapshot.generated_at),
        GRANULARITY_MINUTES,
    );
    let horizon_end = floor + Duration::days(snapshot.horizon_days);
    let availability = availability_intervals(snapshot, timezone, floor, horizon_end)?;
    let available_minutes = availability
        .iter()
        .map(|(start, end)| (*end - *start).num_minutes())
        .sum();
    let mut occupied = constraint_intervals(snapshot, floor, horizon_end);
    occupied.extend(sleep_intervals(snapshot, timezone, floor, horizon_end)?);
    let fixed_minutes = occupied
        .iter()
        .map(|item| (item.end - item.start).num_minutes().max(0))
        .sum();
    let mut preserved_minutes = BTreeMap::<String, i64>::new();
    let mut stability = BTreeMap::<String, Vec<(String, DateTime<Utc>, DateTime<Utc>)>>::new();
    for block in sorted_existing(&snapshot.existing_blocks) {
        stability.entry(block.task_id.clone()).or_default().push((
            block.id.clone(),
            block.starts_at,
            block.ends_at,
        ));
        if block.completed || block.locked || block.starts_at < floor {
            occupied.push(Occupied {
                start: block.starts_at,
                end: block.ends_at + Duration::minutes(snapshot.preferences.transition_minutes),
                location: block.location.clone(),
                course_id: block.course_id.clone(),
            });
            if block.completed || (block.locked && block.ends_at > floor) {
                *preserved_minutes.entry(block.task_id.clone()).or_default() +=
                    (block.ends_at - block.starts_at).num_minutes().max(0);
            }
        }
    }
    occupied.sort_by_key(|item| (item.start, item.end, item.location.clone()));

    let tasks_by_id = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.clone(), task))
        .collect::<BTreeMap<_, _>>();
    let mut pending = snapshot
        .tasks
        .iter()
        .filter(|task| !task.completed)
        .map(|task| task.id.clone())
        .collect::<BTreeSet<_>>();
    let mut task_completion = snapshot
        .tasks
        .iter()
        .filter(|task| task.completed)
        .map(|task| (task.id.clone(), floor))
        .collect::<BTreeMap<_, _>>();
    let mut blocks = Vec::new();
    let mut conflicts = Vec::new();
    while !pending.is_empty() {
        let mut ready = pending
            .iter()
            .filter_map(|id| {
                let task = tasks_by_id.get(id)?;
                task.dependencies
                    .iter()
                    .all(|dependency| task_completion.contains_key(dependency))
                    .then_some(*task)
            })
            .collect::<Vec<_>>();
        ready.sort_by(|left, right| task_order(left, right));
        if ready.is_empty() {
            for id in pending.iter() {
                let task = tasks_by_id[id];
                conflicts.push(OverloadConflict {
                    task_id: id.clone(),
                    title: task.title.clone(),
                    unscheduled_minutes: task.duration_minutes,
                    reason_codes: vec!["blocked_dependency".into()],
                });
            }
            break;
        }
        let task = ready[0];
        pending.remove(&task.id);
        let already = preserved_minutes.get(&task.id).copied().unwrap_or(0);
        let remaining = (task.duration_minutes - already).max(0);
        if remaining == 0 {
            task_completion.insert(task.id.clone(), floor);
            continue;
        }
        let sessions = match split_sessions(task, remaining, &snapshot.preferences) {
            Ok(sessions) => sessions,
            Err(_) => {
                conflicts.push(OverloadConflict {
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    unscheduled_minutes: remaining,
                    reason_codes: vec!["session_limits_infeasible".into()],
                });
                continue;
            }
        };
        let dependency_floor = task
            .dependencies
            .iter()
            .filter_map(|id| task_completion.get(id))
            .max()
            .copied()
            .unwrap_or(floor);
        let mut task_floor = floor
            .max(dependency_floor)
            .max(task.earliest_start.unwrap_or(floor));
        let mut scheduled = 0;
        let stable = stability.get(&task.id).cloned().unwrap_or_default();
        for (index, minutes) in sessions.iter().copied().enumerate() {
            let candidates = candidate_slots(
                task,
                minutes,
                task_floor,
                horizon_end,
                &availability,
                &occupied,
                &stable,
                index,
                timezone,
                matches!(snapshot.trigger, PlannerTrigger::LowEnergy),
            );
            let Some((start, end, reasons)) = candidates.first().cloned() else {
                conflicts.push(OverloadConflict {
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    unscheduled_minutes: remaining - scheduled,
                    reason_codes: if task.due_at.is_some() {
                        vec!["deadline_impossible".into(), "insufficient_capacity".into()]
                    } else {
                        vec!["insufficient_capacity".into()]
                    },
                });
                break;
            };
            let id = stable
                .iter()
                .find(|(_, old_start, old_end)| *old_start == start && *old_end == end)
                .map(|(id, _, _)| id.clone())
                .unwrap_or_else(|| stable_session_id(&task.id, index, start));
            blocks.push(PlannedBlock {
                id,
                task_id: task.id.clone(),
                session_index: index as i64,
                title: task.title.clone(),
                starts_at: start,
                ends_at: end,
                location: task.location.clone(),
                reason_codes: reasons,
            });
            occupied.push(Occupied {
                start,
                end: end
                    + Duration::minutes(
                        snapshot
                            .preferences
                            .break_minutes
                            .max(snapshot.preferences.transition_minutes),
                    ),
                location: task.location.clone(),
                course_id: task.course_id.clone(),
            });
            occupied.sort_by_key(|item| (item.start, item.end, item.location.clone()));
            scheduled += minutes;
            task_floor = end
                + Duration::minutes(
                    snapshot
                        .preferences
                        .break_minutes
                        .max(snapshot.preferences.transition_minutes),
                );
            if index + 1 == sessions.len() {
                task_completion.insert(task.id.clone(), end);
            }
        }
    }
    blocks.sort_by_key(|block| (block.starts_at, block.task_id.clone(), block.session_index));
    conflicts.sort_by_key(|conflict| (conflict.task_id.clone(), conflict.unscheduled_minutes));
    let planned_minutes = blocks
        .iter()
        .map(|block| (block.ends_at - block.starts_at).num_minutes())
        .sum();
    let overload_minutes = conflicts
        .iter()
        .map(|conflict| conflict.unscheduled_minutes)
        .sum();
    Ok(PlanOutcome {
        blocks,
        overload_conflicts: conflicts,
        capacity: CapacitySummary {
            available_minutes,
            fixed_minutes,
            planned_minutes,
            overload_minutes,
        },
    })
}

pub fn rank_next_action(
    snapshot: &PlannerSnapshot,
    outcome: &PlanOutcome,
    now: DateTime<Utc>,
    current_location: Option<&str>,
    available_minutes: i64,
    low_energy: bool,
) -> Option<NextActionOutcome> {
    let task_map = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<BTreeMap<_, _>>();
    let completed = snapshot
        .tasks
        .iter()
        .filter(|task| task.completed)
        .map(|task| task.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut feasible = outcome
        .blocks
        .iter()
        .filter_map(|block| {
            let task = *task_map.get(block.task_id.as_str())?;
            let minutes = (block.ends_at - block.starts_at).num_minutes();
            if block.ends_at <= now
                || minutes > available_minutes
                || task
                    .dependencies
                    .iter()
                    .any(|id| !completed.contains(id.as_str()))
                || low_energy && task.energy_demand == "high"
                || current_location
                    .is_some_and(|location| !task.location.is_empty() && task.location != location)
            {
                return None;
            }
            Some((block, task, minutes))
        })
        .collect::<Vec<_>>();
    feasible.sort_by_key(|(block, task, _)| {
        (
            block.starts_at,
            task.due_at,
            -task.priority,
            -task.academic_risk,
            task.id.clone(),
        )
    });
    let action_index = feasible
        .iter()
        .position(|(block, _, _)| block.starts_at <= round_up(now, GRANULARITY_MINUTES))?;
    let (block, _, minutes) = feasible[action_index];
    let action = to_action(block, minutes);
    let alternatives = feasible
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != action_index)
        .take(2)
        .map(|(_, (block, _, minutes))| to_action(block, *minutes))
        .collect();
    let valid_from = now.max(block.starts_at);
    let valid_until = block.ends_at;
    Some(NextActionOutcome {
        action,
        alternatives,
        valid_from,
        valid_until,
    })
}

fn to_action(block: &PlannedBlock, minutes: i64) -> RankedAction {
    RankedAction {
        block_id: block.id.clone(),
        task_id: block.task_id.clone(),
        concrete_action: block.title.clone(),
        duration_minutes: minutes,
        reason_codes: block.reason_codes.clone(),
    }
}

fn task_order(left: &PlannerTask, right: &PlannerTask) -> Ordering {
    (
        left.due_at.is_none(),
        left.due_at,
        -left.priority,
        -left.academic_risk,
        left.id.as_str(),
    )
        .cmp(&(
            right.due_at.is_none(),
            right.due_at,
            -right.priority,
            -right.academic_risk,
            right.id.as_str(),
        ))
}

fn split_sessions(
    task: &PlannerTask,
    remaining: i64,
    preferences: &PlannerPreferences,
) -> Result<Vec<i64>, String> {
    if !task.splittable {
        return Ok(vec![remaining]);
    }
    let maximum = task
        .max_session_minutes
        .min(preferences.max_session_minutes)
        .max(GRANULARITY_MINUTES);
    let minimum = task
        .min_session_minutes
        .max(preferences.min_session_minutes)
        .max(GRANULARITY_MINUTES)
        .min(maximum);
    let mut count = (remaining + maximum - 1) / maximum;
    while count > 1 && remaining / count < minimum {
        count -= 1;
    }
    let base = (remaining / count / GRANULARITY_MINUTES) * GRANULARITY_MINUTES;
    let mut sessions = vec![base; count as usize];
    let mut rest = remaining - base * count;
    let mut index = 0;
    while rest > 0 {
        let add = GRANULARITY_MINUTES.min(rest);
        sessions[index] += add;
        rest -= add;
        index = (index + 1) % sessions.len();
    }
    if sessions
        .iter()
        .any(|minutes| *minutes < minimum || *minutes > maximum)
    {
        return Err("task cannot be split within its session limits".into());
    }
    Ok(sessions)
}

fn candidate_slots(
    task: &PlannerTask,
    minutes: i64,
    floor: DateTime<Utc>,
    horizon_end: DateTime<Utc>,
    availability: &[(DateTime<Utc>, DateTime<Utc>)],
    occupied: &[Occupied],
    stable: &[(String, DateTime<Utc>, DateTime<Utc>)],
    session_index: usize,
    timezone: Tz,
    low_energy: bool,
) -> Vec<(DateTime<Utc>, DateTime<Utc>, Vec<String>)> {
    let duration = Duration::minutes(minutes);
    let mut candidates = Vec::<(Score, DateTime<Utc>, DateTime<Utc>, Vec<String>)>::new();
    for (available_start, available_end) in availability {
        let mut start = round_up((*available_start).max(floor), GRANULARITY_MINUTES);
        while start + duration <= *available_end && start + duration <= horizon_end {
            let end = start + duration;
            if task.due_at.is_some_and(|due| end > due)
                || occupied
                    .iter()
                    .any(|item| start < item.end && end > item.start)
            {
                start += Duration::minutes(GRANULARITY_MINUTES);
                continue;
            }
            let stable_match = stable
                .get(session_index)
                .is_some_and(|(_, old_start, old_end)| *old_start == start && *old_end == end);
            let local = start.with_timezone(&timezone);
            let energy_fit = if low_energy {
                match task.energy_demand.as_str() {
                    "low" => 0,
                    "medium" => 2,
                    _ => 4,
                }
            } else {
                energy_penalty(&task.energy_demand, local.hour())
            };
            let previous = occupied
                .iter()
                .filter(|item| item.end <= start)
                .max_by_key(|item| item.end);
            let continuity = previous
                .map(|item| {
                    if task.location.is_empty()
                        || item.location.is_empty()
                        || item.location == task.location
                    {
                        0
                    } else {
                        1
                    }
                })
                .unwrap_or(0);
            let switching = previous
                .map(|item| {
                    if item.course_id == task.course_id {
                        0
                    } else {
                        1
                    }
                })
                .unwrap_or(0);
            let slack = task
                .due_at
                .map(|due| -(due - end).num_minutes())
                .unwrap_or(0);
            let score = Score {
                stability: if stable_match { 0 } else { 1 },
                energy: energy_fit,
                continuity,
                switching,
                slack,
                start: start.timestamp(),
            };
            let mut reasons = Vec::new();
            if stable_match {
                reasons.push("plan_stability".into());
            }
            if task
                .due_at
                .is_some_and(|due| due - start <= Duration::hours(48))
            {
                reasons.push("deadline_soon".into());
            }
            if task.priority >= 4 {
                reasons.push("high_priority".into());
            }
            if task.academic_risk >= 3 {
                reasons.push("academic_risk".into());
            }
            if energy_fit == 0 {
                reasons.push("energy_match".into());
            }
            if low_energy {
                reasons.push("low_energy_adjustment".into());
            }
            if continuity == 0 && !task.location.is_empty() {
                reasons.push("location_continuity".into());
            }
            reasons.push("feasible_window".into());
            candidates.push((score, start, end, reasons));
            start += Duration::minutes(GRANULARITY_MINUTES);
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let only = candidates.len() == 1;
    candidates
        .into_iter()
        .map(|(_, start, end, mut reasons)| {
            if only {
                reasons.push("only_feasible_window".into());
            } else {
                reasons.push("best_scored_window".into());
            }
            (start, end, reasons)
        })
        .collect()
}

fn energy_penalty(demand: &str, hour: u32) -> i64 {
    let available = if hour < 12 {
        "high"
    } else if hour < 18 {
        "medium"
    } else {
        "low"
    };
    match (demand, available) {
        (left, right) if left == right => 0,
        ("high", "low") | ("low", "high") => 2,
        _ => 1,
    }
}

fn availability_intervals(
    snapshot: &PlannerSnapshot,
    timezone: Tz,
    floor: DateTime<Utc>,
    horizon_end: DateTime<Utc>,
) -> Result<Vec<(DateTime<Utc>, DateTime<Utc>)>, String> {
    let first = floor.with_timezone(&timezone).date_naive();
    let mut intervals = Vec::new();
    for offset in 0..=snapshot.horizon_days {
        let date = first + Duration::days(offset);
        let weekday = date.weekday().num_days_from_sunday();
        for rule in snapshot
            .preferences
            .availability
            .iter()
            .filter(|rule| rule.weekday == weekday)
        {
            let start = local_datetime(timezone, date, parse_time(&rule.starts_at_local)?, true)?;
            let end = local_datetime(timezone, date, parse_time(&rule.ends_at_local)?, false)?;
            let start = start.max(floor);
            let end = end.min(horizon_end);
            if end > start {
                intervals.push((start, end));
            }
        }
    }
    intervals.sort();
    Ok(intervals)
}

fn constraint_intervals(
    snapshot: &PlannerSnapshot,
    floor: DateTime<Utc>,
    horizon_end: DateTime<Utc>,
) -> Vec<Occupied> {
    snapshot
        .fixed_constraints
        .iter()
        .filter_map(|item| {
            let start = (item.starts_at
                - Duration::minutes(item.travel_before_minutes + item.transition_before_minutes))
            .max(floor);
            let end = (item.ends_at
                + Duration::minutes(item.travel_after_minutes + item.transition_after_minutes))
            .min(horizon_end);
            (end > start).then_some(Occupied {
                start,
                end,
                location: item.location.clone(),
                course_id: None,
            })
        })
        .collect()
}

fn sleep_intervals(
    snapshot: &PlannerSnapshot,
    timezone: Tz,
    floor: DateTime<Utc>,
    horizon_end: DateTime<Utc>,
) -> Result<Vec<Occupied>, String> {
    let sleep_start = parse_time(&snapshot.preferences.sleep_start)?;
    let sleep_end = parse_time(&snapshot.preferences.sleep_end)?;
    let first = floor.with_timezone(&timezone).date_naive() - Duration::days(1);
    let mut intervals = Vec::new();
    for offset in 0..=snapshot.horizon_days + 1 {
        let date = first + Duration::days(offset);
        let end_date = if sleep_end <= sleep_start {
            date + Duration::days(1)
        } else {
            date
        };
        let start = local_datetime(timezone, date, sleep_start, true)?.max(floor);
        let end = local_datetime(timezone, end_date, sleep_end, false)?.min(horizon_end);
        if end > start {
            intervals.push(Occupied {
                start,
                end,
                location: "sleep".into(),
                course_id: None,
            });
        }
    }
    Ok(intervals)
}

fn sorted_existing(existing: &[ExistingBlock]) -> Vec<&ExistingBlock> {
    let mut blocks = existing.iter().collect::<Vec<_>>();
    blocks.sort_by_key(|item| (item.starts_at, item.task_id.clone(), item.id.clone()));
    blocks
}
fn parse_time(value: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| "planner clock value is invalid".into())
}
fn local_datetime(
    timezone: Tz,
    date: NaiveDate,
    time: NaiveTime,
    prefer_earliest: bool,
) -> Result<DateTime<Utc>, String> {
    match timezone.from_local_datetime(&NaiveDateTime::new(date, time)) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, second) => Ok((if prefer_earliest {
            first.min(second)
        } else {
            first.max(second)
        })
        .with_timezone(&Utc)),
        LocalResult::None => {
            Err("local planning time does not exist because of a timezone transition".into())
        }
    }
}
fn round_up(value: DateTime<Utc>, minutes: i64) -> DateTime<Utc> {
    let seconds = minutes * 60;
    let remainder = value.timestamp().rem_euclid(seconds);
    let rounded = if remainder == 0 && value.nanosecond() == 0 {
        value.timestamp()
    } else {
        value.timestamp() + seconds - remainder
    };
    Utc.timestamp_opt(rounded, 0).single().unwrap_or(value)
}
fn stable_session_id(task_id: &str, index: usize, start: DateTime<Utc>) -> String {
    let digest = Sha256::digest(
        format!(
            "student-center-plan:{task_id}:{index}:{}",
            start.timestamp()
        )
        .as_bytes(),
    );
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, Rng, SeedableRng};

    fn snapshot() -> PlannerSnapshot {
        let generated_at = "2026-08-17T14:00:00Z".parse().unwrap();
        PlannerSnapshot {
            generated_at,
            effective_time: generated_at,
            horizon_days: 14,
            timezone: "America/Phoenix".into(),
            preferences: PlannerPreferences {
                sleep_start: "23:00".into(),
                sleep_end: "07:00".into(),
                max_session_minutes: 60,
                min_session_minutes: 20,
                break_minutes: 10,
                transition_minutes: 10,
                availability: (0..7)
                    .map(|weekday| AvailabilityRule {
                        weekday,
                        starts_at_local: "08:00".into(),
                        ends_at_local: "21:00".into(),
                    })
                    .collect(),
            },
            fixed_constraints: vec![FixedConstraint {
                id: "class".into(),
                title: "Class".into(),
                starts_at: "2026-08-17T16:00:00Z".parse().unwrap(),
                ends_at: "2026-08-17T17:00:00Z".parse().unwrap(),
                location: "campus".into(),
                travel_before_minutes: 15,
                travel_after_minutes: 15,
                transition_before_minutes: 10,
                transition_after_minutes: 10,
                kind: "class".into(),
            }],
            tasks: vec![PlannerTask {
                id: "task-a".into(),
                title: "Research paper".into(),
                course_id: Some("eng".into()),
                duration_minutes: 120,
                due_at: Some("2026-08-19T06:59:00Z".parse().unwrap()),
                earliest_start: None,
                priority: 5,
                academic_risk: 4,
                energy_demand: "high".into(),
                location: "library".into(),
                splittable: true,
                min_session_minutes: 30,
                max_session_minutes: 60,
                dependencies: Vec::new(),
                completed: false,
            }],
            existing_blocks: Vec::new(),
            trigger: PlannerTrigger::Initial,
        }
    }

    #[test]
    fn identical_snapshots_are_byte_equivalent_and_non_overlapping() {
        let input = snapshot();
        let first = generate(&input).unwrap();
        let second = generate(&input).unwrap();
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
        for pair in first.blocks.windows(2) {
            assert!(pair[0].ends_at <= pair[1].starts_at);
        }
        assert!(first
            .blocks
            .iter()
            .all(|block| block.starts_at.timestamp() % 300 == 0));
    }

    #[test]
    fn impossible_deadline_is_explicit_overload() {
        let mut input = snapshot();
        input.tasks[0].due_at = Some("2026-08-17T14:10:00Z".parse().unwrap());
        let outcome = generate(&input).unwrap();
        assert!(outcome.blocks.is_empty());
        assert_eq!(outcome.overload_conflicts[0].unscheduled_minutes, 120);
        assert!(outcome.overload_conflicts[0]
            .reason_codes
            .contains(&"deadline_impossible".into()));
    }

    #[test]
    fn dependencies_and_locked_blocks_are_hard_constraints() {
        let mut input = snapshot();
        let locked_start: DateTime<Utc> = "2026-08-17T14:00:00Z".parse().unwrap();
        let locked_end: DateTime<Utc> = "2026-08-17T15:00:00Z".parse().unwrap();
        input.existing_blocks.push(ExistingBlock {
            id: "locked".into(),
            task_id: "locked-task".into(),
            starts_at: locked_start,
            ends_at: locked_end,
            completed: false,
            locked: true,
            location: "home".into(),
            course_id: None,
        });
        input.tasks.insert(
            0,
            PlannerTask {
                id: "prep".into(),
                title: "Prep".into(),
                course_id: None,
                duration_minutes: 30,
                due_at: None,
                earliest_start: None,
                priority: 3,
                academic_risk: 0,
                energy_demand: "medium".into(),
                location: "".into(),
                splittable: false,
                min_session_minutes: 20,
                max_session_minutes: 60,
                dependencies: Vec::new(),
                completed: false,
            },
        );
        input.tasks[1].dependencies = vec!["prep".into()];
        let outcome = generate(&input).unwrap();
        let prep_end = outcome
            .blocks
            .iter()
            .filter(|block| block.task_id == "prep")
            .map(|block| block.ends_at)
            .max()
            .unwrap();
        assert!(outcome
            .blocks
            .iter()
            .filter(|block| block.task_id == "task-a")
            .all(|block| block.starts_at >= prep_end));
        assert!(outcome
            .blocks
            .iter()
            .all(|block| block.starts_at >= locked_end || block.ends_at <= locked_start));
    }

    #[test]
    fn replanning_preserves_completed_past_and_locked_work() {
        let mut input = snapshot();
        for (id, start, completed, locked) in [
            ("past", "2026-08-17T13:00:00Z", false, false),
            ("done", "2026-08-17T14:00:00Z", true, false),
            ("locked", "2026-08-17T15:00:00Z", false, true),
        ] {
            let start: DateTime<Utc> = start.parse().unwrap();
            input.existing_blocks.push(ExistingBlock {
                id: id.into(),
                task_id: format!("{id}-task"),
                starts_at: start,
                ends_at: start + Duration::minutes(30),
                completed,
                locked,
                location: "".into(),
                course_id: None,
            });
        }
        let outcome = generate(&input).unwrap();
        for preserved in &input.existing_blocks {
            assert!(outcome
                .blocks
                .iter()
                .all(|block| block.starts_at >= preserved.ends_at
                    || block.ends_at <= preserved.starts_at));
        }
    }

    #[test]
    fn generated_scenarios_preserve_planner_invariants() {
        let mut rng = StdRng::seed_from_u64(0xC0_51_57_1C);
        for scenario in 0..128 {
            let mut input = snapshot();
            input.fixed_constraints.clear();
            input.tasks = (0..rng.gen_range(1..8))
                .map(|index| PlannerTask {
                    id: format!("scenario-{scenario}-task-{index}"),
                    title: format!("Task {index}"),
                    course_id: Some(format!("course-{}", index % 3)),
                    duration_minutes: rng.gen_range(1..=8) * 15,
                    due_at: Some(input.generated_at + Duration::hours(rng.gen_range(6..=96))),
                    earliest_start: Some(
                        input.generated_at + Duration::minutes(rng.gen_range(0..=120)),
                    ),
                    priority: rng.gen_range(1..=5),
                    academic_risk: rng.gen_range(0..=5),
                    energy_demand: ["low", "medium", "high"][rng.gen_range(0..3)].into(),
                    location: ["", "home", "library"][rng.gen_range(0..3)].into(),
                    splittable: rng.gen_bool(0.7),
                    min_session_minutes: 15,
                    max_session_minutes: 60,
                    dependencies: Vec::new(),
                    completed: false,
                })
                .collect();
            let outcome = generate(&input).unwrap();
            let mut all = outcome.blocks.clone();
            all.sort_by_key(|block| block.starts_at);
            for pair in all.windows(2) {
                assert!(
                    pair[0].ends_at <= pair[1].starts_at,
                    "scenario {scenario} overlapped"
                );
            }
            for block in &all {
                assert_eq!(block.starts_at.timestamp().rem_euclid(300), 0);
                let task = input
                    .tasks
                    .iter()
                    .find(|task| task.id == block.task_id)
                    .unwrap();
                assert!(task.due_at.is_none_or(|due| block.ends_at <= due));
                assert!(task
                    .earliest_start
                    .is_none_or(|earliest| block.starts_at >= earliest));
                let local = block
                    .starts_at
                    .with_timezone(&"America/Phoenix".parse::<Tz>().unwrap());
                assert!((8..21).contains(&local.hour()));
            }
        }
    }

    #[test]
    fn dst_and_zero_capacity_are_safe_and_deterministic() {
        let mut input = snapshot();
        input.timezone = "America/New_York".into();
        input.generated_at = "2026-11-01T05:00:00Z".parse().unwrap();
        input.effective_time = input.generated_at;
        input.fixed_constraints.clear();
        input.preferences.sleep_start = "23:30".into();
        input.preferences.sleep_end = "00:30".into();
        input.preferences.availability = vec![AvailabilityRule {
            weekday: 0,
            starts_at_local: "01:00".into(),
            ends_at_local: "03:30".into(),
        }];
        input.tasks[0].duration_minutes = 30;
        input.tasks[0].due_at = None;
        let first = generate(&input).unwrap();
        let second = generate(&input).unwrap();
        assert_eq!(first, second);
        input.preferences.availability.clear();
        let empty = generate(&input).unwrap();
        assert!(empty.blocks.is_empty());
        assert_eq!(empty.overload_conflicts[0].unscheduled_minutes, 30);
        input.preferences.availability = vec![AvailabilityRule {
            weekday: 0,
            starts_at_local: "02:30".into(),
            ends_at_local: "04:00".into(),
        }];
        input.generated_at = "2026-03-08T06:00:00Z".parse().unwrap();
        input.effective_time = input.generated_at;
        assert!(
            generate(&input).is_err(),
            "nonexistent DST wall times must not be guessed"
        );
    }

    #[test]
    fn next_action_hard_filters_energy_location_dependencies_and_duration() {
        let mut input = snapshot();
        input.fixed_constraints.clear();
        input.tasks[0].duration_minutes = 30;
        input.tasks[0].location = "library".into();
        input.tasks[0].energy_demand = "high".into();
        let outcome = generate(&input).unwrap();
        let now = outcome.blocks[0].starts_at;
        assert!(rank_next_action(&input, &outcome, now, Some("home"), 60, false).is_none());
        assert!(rank_next_action(&input, &outcome, now, Some("library"), 20, false).is_none());
        assert!(rank_next_action(&input, &outcome, now, Some("library"), 60, true).is_none());
        let ranked = rank_next_action(&input, &outcome, now, Some("library"), 60, false).unwrap();
        assert_eq!(ranked.action.task_id, "task-a");
        assert!(ranked.alternatives.len() <= 2);
        assert!(ranked.valid_until > ranked.valid_from);
    }
}
