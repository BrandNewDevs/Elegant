import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { followSystemTheme } from "./theme";

/** Starts a window's page: applies the system theme, then renders the app. */
export function mountApp(app: ReactElement): void {
  followSystemTheme();
  createRoot(document.getElementById("root")!).render(<StrictMode>{app}</StrictMode>);
}
