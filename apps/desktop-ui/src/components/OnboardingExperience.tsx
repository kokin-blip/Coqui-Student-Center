import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CircleAlert,
  Check,
  Clock3,
  FileUp,
  ImageUp,
  LayoutGrid,
  Link2,
  LocateFixed,
  MapPin,
  Plus,
  School,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  AppBootstrap,
  completeOnboarding,
  connectCanvasCalendar,
  importDocumentBytes,
  isDesktop,
  pastedScheduleImage,
  launchScheduleCapture,
  getTimezoneSuggestion,
  getInstitutionSetupOptions,
  OnboardingCourseInput,
  OnboardingDraft,
  OnboardingState,
  saveOnboardingDraft,
  searchCourseSuggestions,
  searchInstitutions,
  selectAndImport,
  InstitutionSelection,
  CourseSuggestion,
  CatalogSection,
  InstitutionSetupOptions,
  InstitutionCampusOption,
  AcademicTermPreset,
} from "../native";
import { AppLogo } from "./AppLogo";
import {
  applyAppearance,
  AppearancePreference,
  ThemeControls,
} from "./ThemeControls";

const timezones = [
  ["Honolulu", "Pacific/Honolulu"],
  ["Anchorage", "America/Anchorage"],
  ["Los Angeles", "America/Los_Angeles"],
  ["Phoenix", "America/Phoenix"],
  ["Denver", "America/Denver"],
  ["Chicago", "America/Chicago"],
  ["New York", "America/New_York"],
  ["Puerto Rico", "America/Puerto_Rico"],
  ["London", "Europe/London"],
  ["Paris", "Europe/Paris"],
  ["New Delhi", "Asia/Kolkata"],
  ["Tokyo", "Asia/Tokyo"],
  ["Sydney", "Australia/Sydney"],
] as const;
const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Catalog sections store 24-hour local times; students read their schedule in
// the 12-hour form the registrar prints.
const formatClock = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return value;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${suffix}`;
};
const courseColors = ["#3155B7", "#0B746B", "#9A5B8E", "#B8653B", "#5E6F2C"];

function emptyCourse(index: number): OnboardingCourseInput {
  return { code: "", title: "", color: courseColors[index % courseColors.length], meetings: [] };
}

function timezoneLabel(timezone: string) {
  try {
    const zone = new Intl.DateTimeFormat([], { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return `${timezone.split("/").at(-1)?.replaceAll("_", " ")} — ${zone ?? timezone}`;
  } catch {
    return timezone;
  }
}

function timezoneFromCoordinates(latitude: number, longitude: number) {
  if (latitude >= 18 && latitude <= 23 && longitude >= -161 && longitude <= -154) return "Pacific/Honolulu";
  if (latitude >= 51 && longitude <= -130) return "America/Anchorage";
  if (longitude <= -114) return "America/Los_Angeles";
  if (longitude <= -108 && latitude <= 37.5) return "America/Phoenix";
  if (longitude <= -101) return "America/Denver";
  if (longitude <= -85) return "America/Chicago";
  return "America/New_York";
}

export function OnboardingExperience({
  state,
  onState,
  onComplete,
}: {
  state: OnboardingState;
  onState: (state: OnboardingState) => void;
  onComplete: (result: AppBootstrap) => void;
}) {
  const normalized = useMemo<OnboardingDraft>(() => ({
    ...state.draft,
    institution: state.draft.institution ?? { id: "", name: "", country: "US", source: "", catalogProviderStatus: "unavailable", custom: false },
    courses: state.draft.courses?.length
      ? state.draft.courses
      : state.draft.courseTitle
        ? [{ code: state.draft.courseCode, title: state.draft.courseTitle, color: courseColors[0], meetings: [] }]
        : [emptyCourse(0)],
    appearance: state.draft.appearance ?? "light",
  }), [state.draft]);
  const [draft, setDraft] = useState(normalized);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(true);
  const [timezoneConfirmed, setTimezoneConfirmed] = useState(Boolean(normalized.timezone));
  const [timezoneDisplay, setTimezoneDisplay] = useState(timezoneLabel(normalized.timezone));
  const [schoolQuery, setSchoolQuery] = useState(normalized.institution.name);
  const [schools, setSchools] = useState<InstitutionSelection[]>([]);
  const [institutionOptions, setInstitutionOptions] = useState<InstitutionSetupOptions | null>(null);
  const [suggestions, setSuggestions] = useState<Record<number, CourseSuggestion[]>>({});
  const [sectionPicker, setSectionPicker] = useState<{ courseIndex: number; suggestion: CourseSuggestion } | null>(null);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [screenshotNotice, setScreenshotNotice] = useState("");
  const [canvasFeedUrl, setCanvasFeedUrl] = useState("");
  // Onboarding reports its own results. The workspace's paste handler writes to
  // a toast and a review modal that are not rendered here, so a paste during
  // setup used to import successfully and then say nothing at all.
  const importScreenshot = async (file: File) => {
    setScreenshotBusy(true);
    setScreenshotNotice("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const next = await importDocumentBytes(file.name || "pasted-image.png", bytes);
      const classes = next.candidates.filter(
        (candidate) => candidate.kind === "class_meeting" && candidate.status === "pending",
      );
      setScreenshotNotice(classes.length
        ? `${classes.length} class${classes.length === 1 ? "" : "es"} read and waiting for your review after setup.`
        : "That image was saved but no class times could be read from it. Add your courses below instead.");
    } catch (next) {
      setScreenshotNotice(String(next));
    } finally {
      setScreenshotBusy(false);
    }
  };
  const [importAfter, setImportAfter] = useState(false);

  const update = <K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    getTimezoneSuggestion().then((suggestion) => {
      if (!draft.timezone) update("timezone", suggestion.timezone);
      setTimezoneDisplay(suggestion.displayName);
      // A timezone read from this computer is already trustworthy. Only a
      // location-derived guess needs an explicit human confirmation.
      setTimezoneConfirmed(true);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isDesktop() || step !== 2) return;
    const onPaste = (event: ClipboardEvent) => {
      const image = pastedScheduleImage(event);
      if (!image) return;
      event.preventDefault();
      void importScreenshot(image);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [step]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveOnboardingDraft(draft).then((next) => {
        onState(next);
        setSaved(true);
      }).catch((next) => setError(String(next)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (step !== 1 || schoolQuery.trim().length < 2) return;
    if (draft.institution.id && schoolQuery.trim() === draft.institution.name.trim()) {
      setSchools([]);
      return;
    }
    const timer = window.setTimeout(() => {
      searchInstitutions(schoolQuery).then(setSchools).catch((next) => setError(String(next)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft.institution.id, draft.institution.name, schoolQuery, step]);

  useEffect(() => {
    if (!draft.institution.id || draft.institution.custom) {
      setInstitutionOptions(null);
      return;
    }
    getInstitutionSetupOptions(draft.institution.id)
      .then((options) => {
        setInstitutionOptions(options);
        if (options.terms.length) {
          setDraft((current) => {
            if (current.termName.trim() && current.termName !== "Current term") return current;
            const preset = options.terms[0];
            setSaved(false);
            return {
              ...current,
              termName: preset.name,
              termStartsOn: preset.startsOn,
              termEndsOn: preset.endsOn,
              termNoClassDates: preset.noClassDates ?? [],
            };
          });
        }
      })
      .catch((next) => setError(String(next)));
  }, [draft.institution.id, draft.institution.custom]);

  const setAppearance = (appearance: AppearancePreference) => {
    applyAppearance(appearance);
    update("appearance", appearance);
  };
  const applyTermPreset = (preset: AcademicTermPreset) => {
    setDraft((current) => ({
      ...current,
      termName: preset.name,
      termStartsOn: preset.startsOn,
      termEndsOn: preset.endsOn,
      // Carried, not just displayed. These were shown on the chip and then
      // dropped, so a student read "2 no-class dates" and still got study
      // blocks scheduled on Thanksgiving.
      termNoClassDates: preset.noClassDates ?? [],
    }));
    setSaved(false);
  };
  // Campuses are a set, but the first one stays special: it is the primary, and
  // it fills the location on new class meetings. "Online or multiple campuses"
  // is a statement that no single campus applies, so it never combines with one.
  const toggleCampus = (campus: InstitutionCampusOption, campuses: InstitutionCampusOption[]) => {
    const selected = draft.institution.campusIds ?? (draft.institution.campusId ? [draft.institution.campusId] : []);
    const flexibleIds = campuses.filter((option) => !option.city || option.city === "Flexible").map((option) => option.id);
    const isFlexible = flexibleIds.includes(campus.id);
    let next: string[];
    if (selected.includes(campus.id)) next = selected.filter((id) => id !== campus.id);
    else if (isFlexible) next = [campus.id];
    else next = [...selected.filter((id) => !flexibleIds.includes(id)), campus.id];
    const names = next.map((id) => campuses.find((option) => option.id === id)?.name ?? "");
    update("institution", { ...draft.institution, campusIds: next, campusNames: names, campusId: next[0] ?? "", campusName: names[0] ?? "" });
  };
  const updateCourse = (index: number, patch: Partial<OnboardingCourseInput>) => {
    const courses = draft.courses.map((course, courseIndex) => courseIndex === index ? { ...course, ...patch } : course);
    update("courses", courses);
  };
  const findCourses = (index: number, query: string) => {
    updateCourse(index, { code: query });
    if (!query.trim()) return setSuggestions((current) => ({ ...current, [index]: [] }));
    searchCourseSuggestions(draft.institution.id, query).then((items) => setSuggestions((current) => ({ ...current, [index]: items }))).catch((next) => setError(String(next)));
  };
  // Picking a catalog section fills the meeting outright. The section shape
  // mirrors ClassMeetingInput, so nothing is derived or guessed here; the
  // student can still edit every field afterwards.
  const applySection = (courseIndex: number, suggestion: CourseSuggestion, section: CatalogSection) => {
    const campusName = institutionOptions?.campuses.find((campus) => campus.id === section.campusId)?.name ?? "";
    const location = [campusName, section.location].filter(Boolean).join(" · ");
    updateCourse(courseIndex, {
      code: suggestion.code,
      title: suggestion.title,
      meetings: [
        ...draft.courses[courseIndex].meetings,
        {
          weekdays: section.weekdays,
          startsAtLocal: section.startsAtLocal,
          endsAtLocal: section.endsAtLocal,
          component: section.component || "lecture",
          location,
          instructorName: section.instructor,
        },
      ],
    });
    setSectionPicker(null);
    setSuggestions((current) => ({ ...current, [courseIndex]: [] }));
  };
  const addMeeting = (courseIndex: number) => updateCourse(courseIndex, {
    meetings: [...draft.courses[courseIndex].meetings, { weekdays: [1, 3, 5], startsAtLocal: "09:00", endsAtLocal: "09:50", component: "lecture", location: draft.institution.campusName ?? "", instructorName: "" }],
  });
  const updateMeeting = (courseIndex: number, meetingIndex: number, patch: Record<string, unknown>) => updateCourse(courseIndex, {
    meetings: draft.courses[courseIndex].meetings.map((meeting, index) => index === meetingIndex ? { ...meeting, ...patch } : meeting),
  });
  const applyAvailabilityPreset = (preset: "balanced" | "working" | "custom") => {
    if (preset === "custom") return;
    update("availability", Array.from({ length: 7 }, (_, weekday) => ({ weekday, startsAtLocal: weekday === 0 || weekday === 6 ? "10:00" : preset === "working" ? "18:00" : "08:00", endsAtLocal: weekday === 0 || weekday === 6 ? "18:00" : "21:00" })));
  };
  // The planner needs at least one window, so the last remaining day is locked
  // rather than letting the student build a draft the backend will reject.
  const toggleAvailability = (weekday: number, checked: boolean) => {
    if (!checked && draft.availability.length <= 1) return;
    update("availability", checked
      ? [...draft.availability, { weekday, startsAtLocal: "08:00", endsAtLocal: "21:00" }].sort((a, b) => a.weekday - b.weekday)
      : draft.availability.filter((item) => item.weekday !== weekday));
  };
  const useLocation = () => {
    if (!navigator.geolocation) return setError("Location is unavailable. Search for a city instead.");
    setBusy(true);
    navigator.geolocation.getCurrentPosition((position) => {
      const timezone = timezoneFromCoordinates(position.coords.latitude, position.coords.longitude);
      update("timezone", timezone);
      setTimezoneDisplay(timezoneLabel(timezone));
      setTimezoneConfirmed(false);
      setBusy(false);
    }, () => {
      setBusy(false);
      setError("Location permission was not granted. Choose a city or keep the detected timezone.");
    }, { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 });
  };
  // Only the profile step is required. School, courses, and weekly rhythm all
  // ship with workable defaults and are editable later, so a student who does
  // not yet know their schedule is never blocked from finishing setup.
  const canContinue = [
    Boolean(draft.name.trim() && draft.timezone && timezoneConfirmed),
    true,
    true,
    true,
  ][step];
  const skippable = step > 0;
  const courseCount = draft.courses.filter((course) => course.title.trim()).length;
  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      const primary = draft.courses.find((course) => course.title.trim());
      let result = await completeOnboarding({ ...draft, courseCode: primary?.code ?? "", courseTitle: primary?.title ?? "", courses: draft.courses.filter((course) => course.title.trim()) });
      if (importAfter && result.dashboard) {
        const dashboard = await selectAndImport();
        if (dashboard) result = { ...result, dashboard };
      }
      onComplete(result);
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };

  const headings = [
    ["Make it yours", "A private planner that starts with your real week."],
    ["School and term", "Optional. It keeps course suggestions relevant."],
    ["Courses and class times", "Optional. Add classes now, or skip and add them later."],
    ["Your weekly rhythm", "Optional. Sensible defaults are already filled in."],
  ];
  return (
    <main className="onboarding-experience">
      <aside className="onboarding-story" aria-label="Setup progress and privacy">
        <AppLogo wordmark />
        <div>
          <p className="eyebrow">Private, local, realistic</p>
          <h1>{headings[step][0]}</h1>
          <p>{headings[step][1]}</p>
        </div>
        <ol className="setup-steps" aria-label="Setup progress">
          {["Profile", "School", "Courses", "Rhythm"].map((label, index) => (
            <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
              <span>{index < step ? <Check /> : index + 1}</span><strong>{label}</strong>
            </li>
          ))}
        </ol>
        <div className="local-promise"><ShieldCheck /><span><strong>Works without an account</strong><small>Your profile and plans stay encrypted on this computer.</small></span></div>
      </aside>
      <section className="setup-panel">
        <header className="setup-panel-head"><span>Step {step + 1} of 4</span><small>{saved ? "Saved locally" : "Saving…"}</small></header>
        {error && <div className="alert" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
        <div className="setup-stage" key={step}>
          {step === 0 && <>
            <div className="setup-intro"><Sparkles /><div><strong>Start empty. Build around your life.</strong><p>No sample student, assignments, or classes will be added.</p></div></div>
            <label className="field full">What should we call you?<input autoFocus value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="Your name" autoComplete="name" /></label>
            <fieldset className="setup-fieldset"><legend>Appearance</legend><ThemeControls value={draft.appearance} onChange={setAppearance} /></fieldset>
            <fieldset className="setup-fieldset"><legend>Your timezone</legend>
              <div className="timezone-card"><Clock3 /><div><strong>{timezoneDisplay}</strong><small>Detected from this computer. Confirm before continuing.</small></div><button className="outline" onClick={useLocation} disabled={busy}><LocateFixed /> Use location</button></div>
              <label className="field">Search by city<select value={draft.timezone} onChange={(event) => { update("timezone", event.target.value); setTimezoneDisplay(timezoneLabel(event.target.value)); setTimezoneConfirmed(true); }}>{timezones.map(([city, zone]) => <option value={zone} key={zone}>{city} · {zone}</option>)}</select></label>
              <label className="confirm-row"><input type="checkbox" checked={timezoneConfirmed} onChange={(event) => setTimezoneConfirmed(event.target.checked)} /><span><strong>Use {timezoneLabel(draft.timezone)}</strong><small>Location coordinates are discarded immediately and never saved.</small></span></label>
            </fieldset>
          </>}
          {step === 1 && <>
            <label className="field full">School or college<div className="input-with-icon"><School /><input autoFocus value={schoolQuery} onChange={(event) => { setSchoolQuery(event.target.value); update("institution", { ...draft.institution, name: event.target.value }); }} placeholder="Start typing your school" /></div></label>
            {schools.length > 0 && <div className="prediction-list" role="listbox" aria-label="School suggestions">{schools.map((school) => <button key={school.id} className={draft.institution.id === school.id ? "selected" : ""} onClick={() => { update("institution", { ...school, campusId: school.matchedCampusId ?? "", campusName: school.matchedCampusName ?? "" }); setSchoolQuery(school.name); setSchools([]); }}><School /><span><strong>{school.name}</strong><small>{school.custom ? "Custom worldwide school" : school.matchedCampusName ? `${school.matchedCampusName} campus · ${school.country} institution directory` : `${school.country} institution directory`}</small></span>{draft.institution.id === school.id && <Check />}</button>)}</div>}
            {draft.institution.name && <div className="selected-school"><MapPin /><span><strong>{draft.institution.name}</strong><small>{draft.institution.catalogProviderStatus === "supported" ? "Course suggestions available" : "Local and general suggestions available"}</small></span></div>}
            {Boolean(institutionOptions?.campuses.length) && <fieldset className="setup-fieldset institution-options"><legend>Campuses</legend><p className="field-help">Select every campus you attend. The first one you pick is your primary campus and fills in the location on new classes; individual classes can still use another.</p><div className="campus-options">{institutionOptions!.campuses.map((campus) => { const selected = draft.institution.campusIds ?? (draft.institution.campusId ? [draft.institution.campusId] : []); const position = selected.indexOf(campus.id); return <button key={campus.id} className={position >= 0 ? "selected" : ""} aria-pressed={position >= 0} onClick={() => toggleCampus(campus, institutionOptions!.campuses)}><MapPin /><span><strong>{campus.name}</strong><small>{position === 0 ? `${campus.city} · Primary` : campus.city}</small></span>{position >= 0 && <Check />}</button>; })}</div><small className="source-note">Campus source: {institutionOptions!.campuses[0].sourceLabel}</small></fieldset>}
            {institutionOptions?.terms.length ? <fieldset className="setup-fieldset institution-options"><legend>Academic term</legend><p className="field-help">Dates below come from the school registrar and remain editable. Official calendars can change, so verify before finalizing.</p><div className="term-options">{institutionOptions.terms.map((preset) => <button key={preset.id} className={draft.termName === preset.name && draft.termStartsOn === preset.startsOn ? "selected" : ""} onClick={() => applyTermPreset(preset)}><span><strong>{preset.name}</strong><small>{preset.details}</small>{/* Finals and breaks are dates a student plans around, and they were being dropped on the floor. */}{preset.classEndsOn && <small>Last day of classes {preset.classEndsOn}{preset.examStartsOn ? ` · Finals from ${preset.examStartsOn}` : ""}</small>}{preset.noClassDates?.length ? <small>{preset.noClassDates.length} no-class {preset.noClassDates.length === 1 ? "date" : "dates"}: {preset.noClassDates.map((date) => date.label).join(", ")}</small> : null}<em>{preset.sourceLabel}</em></span>{draft.termName === preset.name && draft.termStartsOn === preset.startsOn && <Check />}</button>)}</div>{/* "From the registrar" and "from the registrar, in August" are different claims, and only one of them can be checked. */}<small className="source-note">Term source: {institutionOptions.sourceLabel || "school registrar"}{institutionOptions.generatedAt ? ` · recorded ${institutionOptions.generatedAt}` : ""}</small></fieldset> : draft.institution.name && <div className="setup-intro compact"><CalendarDays /><div><strong>No verified calendar connected yet</strong><p>Enter the dates from your registrar. Coqui will not guess them.</p></div></div>}
            <div className="form-grid"><label className="field full">Term name<input value={draft.termName} onChange={(event) => update("termName", event.target.value)} /></label><label className="field">Starts<input type="date" value={draft.termStartsOn} onChange={(event) => update("termStartsOn", event.target.value)} /></label><label className="field">Ends<input type="date" value={draft.termEndsOn} onChange={(event) => update("termEndsOn", event.target.value)} /></label></div>
          </>}
          {step === 2 && <>
            <div className="setup-intro compact"><BookOpen /><div><strong>Don't have your schedule yet?</strong><p>Skip this step. You can add courses and class times any time from Courses.</p></div></div>
            <section className="onboarding-import-center" aria-labelledby="onboarding-import-heading">
              <div className="small-head">
                <div>
                  <strong id="onboarding-import-heading">Bring in my schedule</strong>
                  <p className="field-help">Choose the source you already have. Every detected item waits for review.</p>
                </div>
              </div>
              {isDesktop() && <div className="import-choice-grid">
                <div className="onboarding-canvas-choice">
                  <label className="field full">
                    <span><Link2 aria-hidden="true" /> Connect a Canvas calendar link</span>
                    <input
                      type="url"
                      value={canvasFeedUrl}
                      onChange={(event) => setCanvasFeedUrl(event.target.value)}
                      placeholder="https://canvas.example.edu/feeds/calendars/..."
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <details>
                    <summary>Where do I get this link?</summary>
                    <p className="field-help">In Canvas, open Calendar, choose Calendar Feed, copy the link, and paste it here. Treat it like a password.</p>
                  </details>
                  <button className="outline" disabled={screenshotBusy || !canvasFeedUrl.trim()} onClick={async () => {
                    const submittedUrl = canvasFeedUrl.trim();
                    setCanvasFeedUrl("");
                    setScreenshotBusy(true);
                    setScreenshotNotice("");
                    try {
                      const next = await connectCanvasCalendar(submittedUrl);
                      const count = next.candidates.filter((candidate) => candidate.status === "pending").length;
                      setScreenshotNotice(count ? `${count} Canvas item${count === 1 ? "" : "s"} found and waiting for review after setup.` : "Canvas connected. No new schedule items were found yet.");
                    } catch (next) {
                      setScreenshotNotice(String(next));
                    } finally {
                      setScreenshotBusy(false);
                    }
                  }}><Link2 /> Connect Canvas</button>
                </div>
                <button className="outline" disabled={screenshotBusy} onClick={async () => {
                  setScreenshotBusy(true);
                  setScreenshotNotice("");
                  try {
                    setScreenshotNotice(await launchScheduleCapture());
                  } catch (next) {
                    setScreenshotNotice(String(next));
                  } finally {
                    setScreenshotBusy(false);
                  }
                }}><LayoutGrid /><strong>Capture screen area</strong><span>Use the system snipping tool, then paste here</span></button>
                <button className="outline" disabled={screenshotBusy} onClick={async () => {
                  setScreenshotBusy(true);
                  setScreenshotNotice("");
                  try {
                    const next = await selectAndImport();
                    if (next) {
                      const count = next.candidates.filter((candidate) => candidate.status === "pending").length;
                      setScreenshotNotice(count ? `${count} item${count === 1 ? "" : "s"} extracted and waiting for review after setup.` : "The source was saved, but no schedule items were detected.");
                    }
                  } catch (next) {
                    setScreenshotNotice(String(next));
                  } finally {
                    setScreenshotBusy(false);
                  }
                }}><FileUp /><strong>Import a file or document</strong><span>PDF, image, calendar, Word, Excel, CSV, PowerPoint, or text</span></button>
              </div>}
            </section>
            {/* The fastest path in, for the students who have a screenshot and
                no desire to retype it. Nothing it finds is applied here: the
                classes land in the review queue and are confirmed after setup,
                on the same terms as every other import. Typing courses in by
                hand below stays a complete path on its own. */}
            {isDesktop() && <div className="screenshot-step">
              <label className="field full">
                <span><ImageUp aria-hidden="true" /> Upload a schedule image</span>
                <input type="file" accept="image/png,image/jpeg,application/pdf" disabled={screenshotBusy} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importScreenshot(file);
                }} />
              </label>
              <p className="field-help">Or press Ctrl/Cmd+V anywhere with a screenshot copied. The source is encrypted on your computer and read there; nothing is sent anywhere and nothing is added to your plan until you approve it.</p>
              {screenshotNotice && <p className="source-note" aria-live="polite">{screenshotNotice}</p>}
            </div>}
            <div className="course-builder-head"><div><strong>Your courses</strong><small>Suggestions are optional and always need confirmation.</small></div><button className="outline" onClick={() => update("courses", [...draft.courses, emptyCourse(draft.courses.length)])}><Plus /> Add course</button></div>
            <div className="course-builder">{draft.courses.map((course, courseIndex) => <article key={courseIndex} style={{ "--course-color": course.color } as React.CSSProperties}>
              <header><span>{course.code || `Course ${courseIndex + 1}`}</span>{draft.courses.length > 1 && <button aria-label={`Remove course ${courseIndex + 1}`} onClick={() => update("courses", draft.courses.filter((_, index) => index !== courseIndex))}><Trash2 /></button>}</header>
              <div className="form-grid"><label className="field">Course number<input value={course.code} onChange={(event) => findCourses(courseIndex, event.target.value)} placeholder="MAT 142" /></label><label className="field">Course name<input value={course.title} onChange={(event) => updateCourse(courseIndex, { title: event.target.value })} placeholder="College Mathematics" /></label></div>
              {suggestions[courseIndex]?.length > 0 && <div className="course-suggestions">{suggestions[courseIndex].map((suggestion) => <button key={`${suggestion.source}-${suggestion.code}`} onClick={() => { updateCourse(courseIndex, { code: suggestion.code, title: suggestion.title }); if (suggestion.sections?.length) { setSectionPicker({ courseIndex, suggestion }); } else { setSuggestions((current) => ({ ...current, [courseIndex]: [] })); } }}><span><strong>{suggestion.code} · {suggestion.title}</strong><small>{suggestion.sections?.length ? `${suggestion.sourceLabel} · ${suggestion.sections.length} ${suggestion.sections.length === 1 ? "section" : "sections"}` : suggestion.sourceLabel}</small></span><em>{Math.round(suggestion.confidence * 100)}%</em></button>)}</div>}
              {sectionPicker?.courseIndex === courseIndex && <fieldset className="setup-fieldset institution-options"><legend>Choose your section</legend><p className="field-help">Pick the one you are enrolled in and Coqui fills the days, times, location and instructor. Everything stays editable, and you can skip this and enter the time yourself.</p>{sectionPicker.suggestion.termLabel && <p className="field-help"><strong>These sections are from {sectionPicker.suggestion.termLabel}.</strong> Check them against your registrar if you are enrolled in a different term.</p>}{sectionPicker.suggestion.stalenessWarning&&<div className="alert" role="alert"><CircleAlert/><span>{sectionPicker.suggestion.stalenessWarning}</span></div>}<div className="campus-options">{sectionPicker.suggestion.sections?.map((section) => <button key={section.lineNumber} onClick={() => applySection(courseIndex, sectionPicker.suggestion, section)}><Clock3 /><span><strong>{section.weekdays.length ? `${section.weekdays.map((day) => dayLabels[day]).join(" ")} · ${formatClock(section.startsAtLocal)}–${formatClock(section.endsAtLocal)}` : section.modality === "online" ? "Online — no set meeting time" : section.location}</strong><small>{[section.lineNumber, institutionOptions?.campuses.find((campus) => campus.id === section.campusId)?.name, section.location, section.instructor].filter(Boolean).join(" · ")}</small></span></button>)}</div><button className="ghost" onClick={() => { setSectionPicker(null); setSuggestions((current) => ({ ...current, [courseIndex]: [] })); }}>Skip — I'll enter the time myself</button></fieldset>}
              {course.meetings.map((meeting, meetingIndex) => <div className="meeting-builder" key={meetingIndex}><div className="day-chips">{dayLabels.map((day, dayIndex) => <button className={meeting.weekdays.includes(dayIndex) ? "active" : ""} onClick={() => updateMeeting(courseIndex, meetingIndex, { weekdays: meeting.weekdays.includes(dayIndex) ? meeting.weekdays.filter((value) => value !== dayIndex) : [...meeting.weekdays, dayIndex].sort() })} key={day}>{day}</button>)}</div><div className="form-grid compact"><label className="field">Starts<input type="time" value={meeting.startsAtLocal} onChange={(event) => updateMeeting(courseIndex, meetingIndex, { startsAtLocal: event.target.value })} /></label><label className="field">Ends<input type="time" value={meeting.endsAtLocal} onChange={(event) => updateMeeting(courseIndex, meetingIndex, { endsAtLocal: event.target.value })} /></label><label className="field">Type<select value={meeting.component} onChange={(event) => updateMeeting(courseIndex, meetingIndex, { component: event.target.value })}><option value="lecture">Lecture</option><option value="lab">Lab</option><option value="seminar">Seminar</option></select></label><label className="field">Location<input value={meeting.location} onChange={(event) => updateMeeting(courseIndex, meetingIndex, { location: event.target.value })} /></label><label className="field full">Instructor (optional)<input value={meeting.instructorName} onChange={(event) => updateMeeting(courseIndex, meetingIndex, { instructorName: event.target.value })} /></label></div></div>)}
              <button className="text-button add-meeting" onClick={() => addMeeting(courseIndex)}><Clock3 /> Add class time</button>
            </article>)}</div>
          </>}
          {step === 3 && <>
            <div className="preset-row"><button onClick={() => applyAvailabilityPreset("balanced")}>Balanced week</button><button onClick={() => applyAvailabilityPreset("working")}>Working student</button><button onClick={() => applyAvailabilityPreset("custom")}>Keep custom</button></div>
            <div className="form-grid compact"><label className="field">Sleep starts<input type="time" value={draft.sleepStart} onChange={(event) => update("sleepStart", event.target.value)} /></label><label className="field">Wake time<input type="time" value={draft.sleepEnd} onChange={(event) => update("sleepEnd", event.target.value)} /></label><label className="field">Focus session<input type="number" min="15" max="240" step="5" value={draft.maxSessionMinutes} onChange={(event) => update("maxSessionMinutes", Number(event.target.value))} /></label><label className="field">Break<input type="number" min="0" max="60" step="5" value={draft.breakMinutes} onChange={(event) => update("breakMinutes", Number(event.target.value))} /></label><label className="field">Commute<input type="number" min="0" max="240" step="5" value={draft.defaultCommuteMinutes} onChange={(event) => update("defaultCommuteMinutes", Number(event.target.value))} /></label><label className="field">Transition<input type="number" min="0" max="120" step="5" value={draft.transitionMinutes} onChange={(event) => update("transitionMinutes", Number(event.target.value))} /></label></div>
            <fieldset className="availability visual"><legend>When can Coqui schedule focused work?</legend>{dayLabels.map((day, weekday) => { const rule = draft.availability.find((item) => item.weekday === weekday); return <div key={day}><label><input type="checkbox" checked={Boolean(rule)} disabled={Boolean(rule) && draft.availability.length <= 1} onChange={(event) => toggleAvailability(weekday, event.target.checked)} /><span>{day}</span></label><input type="time" aria-label={`${day} starts`} disabled={!rule} value={rule?.startsAtLocal ?? "08:00"} onChange={(event) => update("availability", draft.availability.map((item) => item.weekday === weekday ? { ...item, startsAtLocal: event.target.value } : item))} /><span>to</span><input type="time" aria-label={`${day} ends`} disabled={!rule} value={rule?.endsAtLocal ?? "21:00"} onChange={(event) => update("availability", draft.availability.map((item) => item.weekday === weekday ? { ...item, endsAtLocal: event.target.value } : item))} /></div>; })}</fieldset>
            <div className="setup-summary"><div><School /><span><strong>{draft.institution.name || "No school yet"}</strong><small>{draft.institution.name ? `${(draft.institution.campusNames ?? []).length > 1 ? `${draft.institution.campusNames!.length} campuses · ` : draft.institution.campusName ? `${draft.institution.campusName} · ` : ""}${draft.termName}` : "Add it later from Settings"}</small></span></div><div><BookOpen /><span><strong>{courseCount === 0 ? "No courses yet" : `${courseCount} ${courseCount === 1 ? "course" : "courses"}`}</strong><small>{courseCount === 0 ? "Add them any time from Courses" : `${draft.courses.reduce((sum, course) => sum + course.meetings.length, 0)} weekly class patterns`}</small></span></div><div><Clock3 /><span><strong>{draft.availability.length} available days</strong><small>{draft.maxSessionMinutes}-minute focus sessions</small></span></div></div>
            <label className="confirm-row"><input type="checkbox" checked={importAfter} onChange={(event) => setImportAfter(event.target.checked)} /><span><strong>Choose my first syllabus after setup</strong><small>Every extracted fact will still require review.</small></span></label>
          </>}
        </div>
        <footer className="setup-actions">{step > 0 ? <button className="outline" onClick={() => setStep((value) => value - 1)}><ArrowLeft /> Back</button> : <span />}<div className="setup-actions-end">{skippable && <button className="text-button" disabled={busy} onClick={() => step === 3 ? void finish() : setStep((value) => value + 1)}>Skip for now</button>}<button className="solid" disabled={!canContinue || busy} onClick={() => step === 3 ? void finish() : setStep((value) => value + 1)}>{step === 3 ? "Build my first plan" : "Continue"}<ArrowRight /></button></div></footer>
      </section>
    </main>
  );
}
