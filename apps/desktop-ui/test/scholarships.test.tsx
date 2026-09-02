import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

beforeEach(() => window.history.replaceState({}, "", "/?demo"));

test("a student can save an attributed scholarship and version a draft", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  const [nav] = await screen.findAllByRole(
    "button",
    { name: "Scholarships" },
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
