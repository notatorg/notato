import { createRoot } from "react-dom/client";
import { NotFound } from "./NotFound.tsx";
import "./theme.ts";

createRoot(document.getElementById("root") as HTMLElement).render(<NotFound standalone />);
