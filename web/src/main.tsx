import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BoardPage } from "./pages/BoardPage";
import { BrainsPage } from "./pages/BrainsPage";
import "./styles.css";

const page = location.pathname.replace(/\/+$/, "") === "/brain" ? <BoardPage /> : <BrainsPage />;

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>);
