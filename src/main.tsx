import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App.tsx";
import "@/app/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
