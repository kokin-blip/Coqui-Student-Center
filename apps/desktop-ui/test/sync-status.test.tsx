import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

const timeout = { timeout: 8000 };

const openAccount = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }, timeout));
  await user.click(
    await screen.findByRole("button", { name: /Account & encrypted sync/ }, timeout),
  );
  return user;
};

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo&account=signed");
});

test("staged changes from a newer version are described honestly", async () => {
  window.history.replaceState({}, "", "/?demo&account=signed&sync=staged");
  render(<StudentCenter />);
  await openAccount();

  await screen.findByText(
    "Changes from a newer version are waiting",
    undefined,
    timeout,
  );
  // The old copy claimed these came from an interrupted transaction and would be retried as a
  // batch. Nothing did that: the state was unreachable. It now means "this build is too old".
  expect(screen.queryByText(/interrupted transaction/i)).toBeNull();
  expect(screen.queryByText(/Downloaded changes are safely staged/i)).toBeNull();
  expect(
    screen.getByText(/applied automatically after you update/i),
  ).toBeTruthy();
});

test("the staged-changes notice is absent when nothing is waiting", async () => {
  render(<StudentCenter />);
  await openAccount();
  await screen.findByRole("heading", { name: "Optional Student Center account" }, timeout);

  expect(
    screen.queryByText("Changes from a newer version are waiting"),
  ).toBeNull();
});
