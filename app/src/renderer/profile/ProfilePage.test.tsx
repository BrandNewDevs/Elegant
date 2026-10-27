import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { nothingDone, pushSetupState } from "@/lib/test-electron";
import { Toaster } from "@/components/ui/sonner";
import { ProfilePage } from "./ProfilePage";

it("asks for a name with the placeholder 'Your name', and only offers Save once it is typed", () => {
  const send = pushSetupState(nothingDone);
  render(<ProfilePage />);
  const field = screen.getByLabelText("Name") as HTMLInputElement;
  expect(field.placeholder).toBe("Your name");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(field, { target: { value: "  Kenny " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(send.setUserName).toHaveBeenCalledWith("  Kenny ");
});

it("shows the saved name, and Save stays off until it differs", () => {
  pushSetupState({ ...nothingDone, userName: "Kenny" });
  render(<ProfilePage />);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Kenny");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ken" } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});

it("confirms a save with a toast", async () => {
  pushSetupState(nothingDone);
  render(<><ProfilePage /><Toaster /></>);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kenny" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Name saved")).toBeTruthy();
});
