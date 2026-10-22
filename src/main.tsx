import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";
import "./theme.css";
const savedTheme = localStorage.getItem("filedesk-theme");
document.documentElement.dataset.theme =
  savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
