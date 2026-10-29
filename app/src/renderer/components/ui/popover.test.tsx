import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MenuItem, Popover } from "./popover";

function menu(onPick = vi.fn()) {
  render(
    <div>
      <Popover role="menu" label="Actions" trigger={(props) => <button {...props}>Open</button>}>
        <MenuItem onClick={onPick}>Pick me</MenuItem>
      </Popover>
      <p>outside</p>
    </div>,
  );
  return onPick;
}

it("opens from its trigger, says so to assistive tech, and closes again", () => {
  menu();
  const trigger = screen.getByRole("button", { name: "Open" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes on Escape and on a click outside", () => {
  menu();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.mouseDown(screen.getByText("outside"));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("runs a chosen item and closes a menu, but stays open for a click inside a dialog panel", () => {
  const picked = menu();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pick me" }));
  expect(picked).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("keeps a dialog panel open while the person works inside it", () => {
  render(<Popover label="Form" trigger={(props) => <button {...props}>Open</button>}><input aria-label="Name" /></Popover>);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.mouseDown(screen.getByLabelText("Name"));
  fireEvent.click(screen.getByLabelText("Name"));
  expect(screen.getByRole("dialog", { name: "Form" })).toBeTruthy();
});
