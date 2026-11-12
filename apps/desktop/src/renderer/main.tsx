import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root");
createRoot(root).render(<App api={window.memelens} />);
