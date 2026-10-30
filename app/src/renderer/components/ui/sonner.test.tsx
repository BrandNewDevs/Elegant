import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { expect, it } from "vitest";
import { Toaster } from "./sonner";

it("gives every toast a close button, on its top-right corner and outside it, that dismisses it", async () => {
  const { container } = render(<Toaster />);
  act(() => void toast("A Summary is ready", { duration: Infinity }));
  const close = await screen.findByRole("button", { name: "Close toast" });

  const toaster = container.ownerDocument.querySelector("[data-sonner-toaster]") as HTMLElement;
  expect(toaster.style.getPropertyValue("--toast-close-button-end")).toBe("0");
  expect(toaster.style.getPropertyValue("--toast-close-button-start")).toBe("unset");
  expect(toaster.style.getPropertyValue("--toast-close-button-transform")).toBe("translate(35%, -35%)");

  act(() => close.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  expect(screen.queryByText("A Summary is ready")).toBeNull();
});
