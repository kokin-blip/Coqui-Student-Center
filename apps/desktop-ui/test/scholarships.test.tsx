import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { StudentCenter } from "../src/StudentCenter";
import { ScholarshipsView } from "../src/components/ScholarshipsView";
import * as native from "../src/native";

beforeEach(() => window.history.replaceState({}, "", "/?demo"));

test("discovered funding can be narrowed by published type and major criteria", async () => {
  const workspace = await native.getScholarshipWorkspace();
  const opportunity = (id: string, type: "grant" | "scholarship", fieldsOfStudy: string[]): native.ScholarshipOpportunity => ({
    id, sourceId: "coqui-public-catalog", canonicalUrl: `https://example.org/${id}`,
    applicationUrl: `https://example.org/${id}`, provider: "Example Foundation", title: `${id} funding`,
    opportunityType: type, studyLevels: [], fieldsOfStudy, locations: [], citizenship: [], residency: [],
    essayPrompts: [], requiredDocuments: [], fetchedAt: "2026-09-22T12:00:00Z", freshness: "fresh",
    verificationStatus: "unverified", aiPolicy: "unknown", notes: "", priority: "medium", state: "discovered", taskIds: [],
  });
  const getWorkspace = vi.spyOn(native, "getScholarshipWorkspace").mockResolvedValue({ ...workspace, opportunities: [{ ...opportunity("Biology", "grant", ["Biology"]), awardMinimum: 1500 }, opportunity("History", "scholarship", ["History"])], profile: { ...workspace.profile, studyLevel: "undergraduate", preferredOpportunityTypes: ["grant"], awardMinimum: 1000 } });
  try {
    const user = userEvent.setup();
    render(<ScholarshipsView />);
    expect(await screen.findByText("Biology funding")).toBeInTheDocument();
    expect(screen.getByText(/Profile preferences: Preferred type: grant · Published minimum meets your \$1,000 target/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "grant");
    expect(screen.queryByText("History funding")).not.toBeInTheDocument();
    await user.click(screen.getByText("More filters"));
    await user.type(screen.getByLabelText("Published major criteria"), "chemistry");
    expect(screen.getByText(/No discovered opportunities match these filters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("History funding")).toBeInTheDocument();
  } finally {
    getWorkspace.mockRestore();
  }
});

test("funding AI proposal stays review-only until the student saves the edited profile", async () => {
  const workspace = await native.getScholarshipWorkspace();
  const empty = { ...workspace, profile: { ...workspace.profile, studyLevel: "", fieldsOfStudy: [] } };
  const getWorkspace = vi.spyOn(native, "getScholarshipWorkspace").mockResolvedValue(empty);
  const propose = vi.spyOn(native, "requestFundingProfileProposal").mockResolvedValue({ suggestions: [
    { field: "fieldsOfStudy", quote: "computer science" },
    { field: "school", quote: "Arizona State University" },
  ] });
  const providers = vi.spyOn(native, "listAiProviders").mockResolvedValue([{ provider: "openai", connected: true, healthy: true, model: "test-model", capabilities: ["funding_profile"], disclosureUrl: "https://example.invalid/policy" }]);
  const save = vi.spyOn(native, "saveScholarshipProfile").mockImplementation(async (profile) => ({ ...empty, profile }));
  const user = userEvent.setup();
  render(<ScholarshipsView />);
  expect(await screen.findByRole("heading", { name: "Find funding that fits you" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Help me organize my details with AI" }));
  await user.type(screen.getByLabelText("What should funding searches know about you?"), "I study computer science at Arizona State University.");
  expect(screen.getByRole("button", { name: "Create review draft" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /Send only this description/ }));
  await user.click(screen.getByRole("button", { name: "Create review draft" }));
  await waitFor(() => expect(propose).toHaveBeenCalledWith("I study computer science at Arizona State University.", true, "openai"));
  expect(save).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "Apply suggestions to editable fields" }));
  expect(screen.getByLabelText("School")).toHaveValue("Arizona State University");
  expect(screen.getByLabelText("Major or fields of study")).toHaveValue("computer science");
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start finding funding" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ school: "Arizona State University", fieldsOfStudy: ["computer science"] })));
  expect(await screen.findByRole("heading", { name: "Funding" })).toBeVisible();
  getWorkspace.mockRestore();
  propose.mockRestore();
  providers.mockRestore();
  save.mockRestore();
});

test("saved funding profile can opt out without losing onboarding preferences", async () => {
  const workspace = await native.getScholarshipWorkspace();
  const profile = { ...workspace.profile, studyLevel: "undergraduate", school: "Arizona State University", degree: "BS", academicYear: "Junior", interests: ["Robotics"], preferredOpportunityTypes: ["grant"], awardMinimum: 1000, deadlineToleranceDays: 30, notificationsEnabled: true };
  const getWorkspace = vi.spyOn(native, "getScholarshipWorkspace").mockResolvedValue({ ...workspace, profile });
  const save = vi.spyOn(native, "saveScholarshipProfile").mockImplementation(async (next) => ({ ...workspace, profile: next }));
  try {
    const user = userEvent.setup();
    render(<ScholarshipsView />);
    await user.click(await screen.findByRole("button", { name: "Saved" }));
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.clear(screen.getByLabelText("Interests, comma separated"));
    await user.type(screen.getByLabelText("Interests, comma separated"), "Climate change, public service");
    await user.clear(screen.getByLabelText("Minimum preparation time (days)"));
    await user.type(screen.getByLabelText("Minimum preparation time (days)"), "45");
    await user.click(screen.getByRole("checkbox", { name: /Notify me about funding/ }));
    await user.click(screen.getByRole("button", { name: "Save matching profile" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      notificationsEnabled: false,
      school: "Arizona State University",
      degree: "BS",
      academicYear: "Junior",
      interests: ["Climate change", "public service"],
      preferredOpportunityTypes: ["grant"],
      awardMinimum: 1000,
      deadlineToleranceDays: 45,
    })));
  } finally {
    getWorkspace.mockRestore();
    save.mockRestore();
  }
});

test("a student can save an attributed scholarship and version a draft", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  const [nav] = await screen.findAllByRole(
    "button",
    { name: "Funding" },
    { timeout: 8000 },
  );
  await user.click(nav);
  expect(
    await screen.findByText("ASU Scholarship Universe"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("CareerOneStop Scholarship Finder API"),
  ).toBeInTheDocument();
  await user.type(
    await screen.findByLabelText("Opportunity title"),
    "Community Leadership Scholarship",
  );
  await user.type(screen.getByLabelText("Provider"), "Example Foundation");
  await user.type(
    screen.getByLabelText("Public HTTPS URL"),
    "https://example.org/scholarship",
  );
  await user.click(screen.getByRole("button", { name: "Save opportunity" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "encrypted local workspace",
  );
  await user.click(screen.getByRole("button", { name: "Saved" }));
  expect(
    screen.getByText("Community Leadership Scholarship"),
  ).toBeInTheDocument();
  await user.upload(
    screen.getByLabelText("Import file"),
    new File(
      [
        "Official transcript\nTwo letters of recommendation\nEssay prompt: Describe how your service shaped your goals. 500 words",
      ],
      "provider-requirements.txt",
      { type: "text/plain" },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Requirements extracted locally",
  );
  expect(
    await screen.findByText("provider-requirements.txt"),
  ).toBeInTheDocument();
  expect(await screen.findByText(/Review required/)).toBeInTheDocument();
  expect(screen.getByText("Official transcript")).toBeInTheDocument();
  expect(screen.getByText("Letter of recommendation")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Apply selected details" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Reviewed scholarship details applied",
  );
  expect(screen.getByText(/Reviewed and applied/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Writing" }));
  await user.type(
    screen.getByPlaceholderText(/Start with the specific experience/),
    "I organized a neighborhood tutoring program.",
  );
  await user.click(screen.getByRole("button", { name: "Save version" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "version saved locally",
  );
  expect(screen.getByText(/1 saved version/)).toBeInTheDocument();
  expect(screen.getByText("Version history")).toBeInTheDocument();

  await user.type(
    screen.getByPlaceholderText(/Start with the specific experience/),
    " It now serves twenty students.",
  );
  expect(
    await screen.findByText(/Autosaved/, undefined, { timeout: 3000 }),
  ).toBeInTheDocument();
  expect(screen.getByText(/1 saved version/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(screen.getByRole("status")).toHaveTextContent("Older text restored");
  expect(
    screen.getByPlaceholderText(/Start with the specific experience/),
  ).toHaveValue("I organized a neighborhood tutoring program.");

  await user.type(screen.getByLabelText("Story title"), "Tutoring program");
  await user.type(
    screen.getByLabelText("What happened"),
    "I recruited five volunteers and scheduled weekly sessions.",
  );
  await user.type(screen.getByLabelText("Tags"), "leadership, service");
  await user.click(screen.getByRole("button", { name: "Save story" }));
  expect(await screen.findByText("Tutoring program")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Build checklist" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "checklist created",
  );
  await user.click(screen.getByRole("button", { name: "Applications" }));
  expect(
    screen.getByLabelText(/Status for Community Leadership Scholarship/),
  ).toHaveValue("preparing");
  await user.click(
    screen.getByRole("checkbox", { name: "Verify eligibility and deadline" }),
  );
  expect(await screen.findByText("1/4 steps complete")).toBeInTheDocument();
});
