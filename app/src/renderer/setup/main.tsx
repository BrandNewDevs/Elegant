import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SetupApp } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SetupApp />
  </StrictMode>,
);
