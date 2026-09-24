import axe from "axe-core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { SemesterPlannerView } from "../src/components/SemesterPlannerView";

afterEach(() => vi.restoreAllMocks());

test("a manual schedule idea is reviewable and never changes enrolled meetings", async () => {
  const workspace = await native.getLocalWorkspace();
  const save = vi.spyOn(native, "upsertSemesterScenario").mockImplementation(async (scenario) => [{ ...scenario, version: 1 }]);
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([]);
  const user = userEvent.setup();
  render(<main><SemesterPlannerView /></main>);
  await user.click(await screen.findByRole("button", { name: "Start empty idea" }));
  await user.click(screen.getByRole("button", { name: "Add candidate section" }));
  expect(screen.getByRole("heading", { name: "Compared with current schedule" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name:/Estimated round-trip commute/ })).toBeInTheDocument();
  expect(screen.getByRole("row", { name:/Known open assignment effort/ })).toBeInTheDocument();
  const accessibility = await axe.run(document.body, { rules: { "color-contrast": { enabled:false } } });
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  const section = screen.getByRole("group", { name: "Section 1" });
  expect(within(section).getByLabelText("Course")).toHaveValue(workspace.courses[0].id);
  await user.selectOptions(within(section).getByLabelText("Repeats every"), "2");
  const rotationWeek = within(section).getByLabelText("Occurs in week");
  await user.selectOptions(rotationWeek, within(rotationWeek).getByRole("option", { name:"2" }));
  expect(within(section).getByLabelText("Occurs in week")).toHaveValue("1");
  await user.clear(screen.getByLabelText("Idea name"));
  await user.type(screen.getByLabelText("Idea name"), "  Morning option  ");
  await user.click(screen.getByRole("button", { name: "Save idea" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Morning option", termId: workspace.terms[0].id, sections: [expect.objectContaining({ courseId: workspace.courses[0].id, rotationIntervalWeeks:2, rotationOffsetWeeks:1 })] }));
  expect(await screen.findByRole("status")).toHaveTextContent("enrolled schedule and study plan were not changed");
});

test("instructor names remain available without a separate professor catalog or RMP links", async () => {
  const workspace = await native.getLocalWorkspace();
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([]);
  vi.spyOn(native, "getProfessorCatalog").mockResolvedValue([
    { id:"catalog:1", name:"Jane Doe", institutionId:"104151", courseId:workspace.courses[0].id, courseCode:workspace.courses[0].code, email:"", officeLocation:"", officeHours:"", source:{kind:"official_course_catalog",label:"ASU Class Search",url:"https://catalog.apps.asu.edu/catalog/classes",termLabel:"Fall 2026",campusId:"tempe",sectionNumbers:["12345"],capturedAt:"2026-08-19"} },
    { id:"local:2", name:"Jo Smith", institutionId:"104151", courseId:workspace.courses[0].id, courseCode:workspace.courses[0].code, email:"jo@example.edu", officeLocation:"Room 2", officeHours:"", source:{kind:"local_course",label:"Your saved course details",url:"",termLabel:"",campusId:"",sectionNumbers:[],capturedAt:null} },
  ]);
  render(<main><SemesterPlannerView /></main>);
  expect(await screen.findByRole("region", { name:"Will this schedule work for your week?" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name:"Instructors for your courses" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name:/RMP search/ })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name:"Start empty idea" }));
  await userEvent.setup().click(screen.getByRole("button", { name:"Add candidate section" }));
  expect(within(screen.getByRole("group", { name:"Section 1" })).getByRole("option", { name:/Jane Doe/ })).toBeInTheDocument();
  const accessibility = await axe.run(document.body, { rules: { "color-contrast": { enabled:false } } });
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
});

test("a catalog instructor stays attached to a saved idea with source evidence", async () => {
  const workspace = await native.getLocalWorkspace();
  const professor: native.ProfessorRecord = { id:"catalog:verified", name:"Jane Doe", institutionId:"104151", courseId:workspace.courses[0].id, courseCode:workspace.courses[0].code, email:"", officeLocation:"", officeHours:"", source:{kind:"official_course_catalog",label:"ASU Class Search",url:"https://catalog.apps.asu.edu/catalog/classes",termLabel:"Fall 2026",campusId:"tempe",sectionNumbers:["12345"],capturedAt:null} };
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([]);
  vi.spyOn(native, "getProfessorCatalog").mockResolvedValue([professor]);
  const lookup = vi.spyOn(native, "lookupProfessorRating").mockResolvedValue({ value:4.3, reviewCount:12, sourceUrl:"https://www.ratemyprofessors.com/professor/42", updatedAt:"2026-09-23T00:00:00Z", biasWarning:"Student reviews are self-selected." });
  const save = vi.spyOn(native, "upsertSemesterScenario").mockImplementation(async (scenario) => [{ ...scenario, version:1 }]);
  const user = userEvent.setup();
  render(<main><SemesterPlannerView /></main>);
  await user.click(await screen.findByRole("button", { name:"Start empty idea" }));
  await user.click(screen.getByRole("button", { name:"Add candidate section" }));
  const section = screen.getByRole("group", { name:"Section 1" });
  await user.selectOptions(within(section).getByLabelText("Instructor"), professor.id);
  expect(await within(section).findByText(/RMP 4\.3\/5 · 12 student reviews/)).toBeInTheDocument();
  expect(lookup).toHaveBeenCalledWith(professor.id);
  expect(within(section).getByText(/Not used to determine schedule feasibility/)).toBeInTheDocument();
  expect(within(section).getByText("Jane Doe · catalog listing")).toBeInTheDocument();
  expect(within(section).getByText(/Fall 2026 · tempe campus/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name:"Save idea" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ sections:[expect.objectContaining({ professorRecordId:professor.id, instructorId:undefined })] }));
  await user.click(screen.getByRole("button", { name:"Close" }));
  await user.click(screen.getByRole("button", { name:/New schedule idea/ }));
  expect(screen.getByText("Jane Doe · catalog listing")).toBeInTheDocument();
  const accessibility = await axe.run(document.body, { rules:{ "color-contrast":{enabled:false} } });
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
});

test("an unavailable catalog reference remains visible but cannot be resaved", async () => {
  const workspace = await native.getLocalWorkspace();
  const scenario: native.SemesterScenario = { id:crypto.randomUUID(), termId:workspace.terms[0].id, name:"Old catalog idea", version:1, sections:[{ id:crypto.randomUUID(), courseId:workspace.courses[0].id, professorRecordId:"catalog:retired", weekdays:[1], startsAtLocal:"09:00", endsAtLocal:"10:00", location:"", modality:"unknown" }] };
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([scenario]);
  vi.spyOn(native, "getProfessorCatalog").mockResolvedValue([]);
  render(<main><SemesterPlannerView /></main>);
  await userEvent.setup().click(await screen.findByRole("button", { name:/Old catalog idea/ }));
  expect(screen.getByText(/catalog listing is no longer available/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name:"Save idea" })).toBeDisabled();
});

test("a timed catalog section fills only the draft and retains source evidence", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([]);
  vi.spyOn(native, "getSemesterCatalogSections").mockResolvedValue([{ courseId:course.id, courseCode:course.code, sourceLabel:"Official Class Search", sourceUrl:"https://example.edu/classes", termLabel:workspace.terms[0].name, professorRecordId:undefined, section:{lineNumber:"12345",component:"lecture",weekdays:[2,4],startsAtLocal:"13:30",endsAtLocal:"14:45",campusId:"main",location:"Building 1",instructor:"Jane Doe",modality:"in-person"} }]);
  const save = vi.spyOn(native, "upsertSemesterScenario").mockImplementation(async (scenario) => [{ ...scenario, version:1 }]);
  const user = userEvent.setup();
  render(<main><SemesterPlannerView /></main>);
  await user.click(await screen.findByRole("button", { name:"Start empty idea" }));
  await user.selectOptions(await screen.findByLabelText("Available catalog section"), "0");
  await user.click(screen.getByRole("button", { name:"Add listed section" }));
  const section = screen.getByRole("group", { name:"Section 1" });
  expect(within(section).getByLabelText("Start")).toHaveValue("13:30");
  expect(within(section).getByLabelText("Location")).toHaveValue("Building 1");
  expect(within(section).getByText("Catalog section #12345")).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name:"Save idea" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ sections:[expect.objectContaining({ courseId:course.id, catalogSectionLineNumber:"12345", weekdays:[2,4], modality:"in_person" })] }));
  await user.click(screen.getByRole("button", { name:"Close" }));
  await user.click(screen.getByRole("button", { name:/New schedule idea/ }));
  expect(screen.getByText("Catalog section #12345")).toBeInTheDocument();
  const accessibility = await axe.run(document.body, { rules:{ "color-contrast":{enabled:false} } });
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
});

test("a dropped schedule screenshot becomes an unsaved, correctable scenario", async () => {
  const workspace = await native.getLocalWorkspace();
  const original = await native.getDashboard();
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  vi.spyOn(native, "getSemesterScenarios").mockResolvedValue([]);
  vi.spyOn(native, "getDashboard").mockResolvedValue(original);
  const imported = vi.spyOn(native, "importDocumentBytes").mockResolvedValue({ ...original, candidates:[...original.candidates, { id:"shot-class", documentId:"shot-doc", kind:"class_meeting", title:"Biology lecture", course:"BIO 181", weekdays:[1,3], startsAtLocal:"09:00", endsAtLocal:"10:15", location:"Campus", modality:"in-person", evidence:"BIO 181 MW 9:00", sourceLocator:"screenshot", sourceType:"screenshot", confidence:.9, warnings:[], status:"pending" }] });
  const saved = vi.spyOn(native, "upsertSemesterScenario");
  const user = userEvent.setup();
  render(<main><SemesterPlannerView /></main>);
  const file = new File(["image"], "schedule.png", { type:"image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1,2,3]).buffer });
  await user.upload(await screen.findByLabelText("Choose a schedule"), file);
  expect(imported).toHaveBeenCalled();
  expect(await screen.findByDisplayValue("Screenshot schedule idea")).toBeInTheDocument();
  const section = screen.getByRole("group", { name:"Section 1" });
  expect(within(section).getByLabelText("Start")).toHaveValue("09:00");
  expect(within(section).getByLabelText("Course")).toHaveValue("");
  expect(within(section).getByRole("option", { name:/Match BIO 181 to a course/ })).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByText(/Your enrolled schedule did not change/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name:"Save idea" })).toBeDisabled();
});
