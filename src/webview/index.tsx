import { createRoot } from "react-dom/client";
import { Board } from "./Board";
import { Sidebar } from "./Sidebar";
import { startMessageBridge } from "./messaging";

startMessageBridge();

const mode = window.__DOSTUFF_MODE__ ?? "sidebar";
const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(mode === "board" ? <Board /> : <Sidebar />);
}
