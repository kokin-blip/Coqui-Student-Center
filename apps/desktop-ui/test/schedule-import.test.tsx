import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

test("schedule review keeps the source beside editable candidates", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  await user.click(
    await screen.findByRole("button", { name: "Review candidates" }, { timeout: 8000 }),
  );
  const dialog = await screen.findByRole("dialog", undefined, { timeout: 8000 });
  expect(within(dialog).getByLabelText("Imported schedule source")).toBeInTheDocument();

  await user.selectOptions(within(dialog).getByLabelText("Source"), "00000000-0000-4000-8000-000000000202");
  expect(within(dialog).getByText(/Approval action: add new record/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Edit fields" }));
  expect(within(dialog).getByLabelText("Academic term")).toHaveDisplayValue(/Fall 2026/);
  const section = within(dialog).getByLabelText("Section");
  await user.type(section, "A01");
  await user.type(within(dialog).getByLabelText("Location"), "COOR 174");
  await user.click(within(dialog).getByRole("button", { name: /Save candidate/ }));

  expect(await within(dialog).findByText(/Section A01/)).toBeInTheDocument();
  expect(within(dialog).getByText(/Fall 2026 · 2026-08-01–2026-12-20/)).toBeInTheDocument();
  expect(within(dialog).getByText(/Edited by you/)).toBeInTheDocument();
});
