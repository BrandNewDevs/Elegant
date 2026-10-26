import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { PromptApp } from "./App";

document.documentElement.classList.add("bg-transparent");
document.body.classList.add("bg-transparent");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PromptApp />
  </StrictMode>,
);
