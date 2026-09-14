import React from "react";
import { createRoot } from "react-dom/client";
import "./ui/styles.js";
import { ACTIVE_LANG } from "./i18n/index.js";
import { PracticeApp } from "./app/PracticeApp.js";

class ErrBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { this.setState({ err, info }); }
  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    const text =
      (ACTIVE_LANG === "en" ? "MESSAGE:\n" : "СООБЩЕНИЕ:\n") + (e && e.message ? e.message : String(e)) +
      (ACTIVE_LANG === "en" ? "\n\nSTACK:\n" : "\n\nСТЕК:\n") + (e && e.stack ? e.stack : (ACTIVE_LANG === "en" ? "(none)" : "(нет)")) +
      (ACTIVE_LANG === "en" ? "\n\nCOMPONENTS:\n" : "\n\nКОМПОНЕНТЫ:\n") + (this.state.info && this.state.info.componentStack
        ? this.state.info.componentStack : (ACTIVE_LANG === "en" ? "(none)" : "(нет)"));
    return React.createElement("pre", {
      style: { margin: 0, padding: "16px", background: "#111", color: "#fff", fontSize: "11px", lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-all", overflowWrap: "anywhere", minHeight: "100vh", WebkitUserSelect: "text", userSelect: "text" },
    }, text);
  }
}

createRoot(document.getElementById("root")).render(
  <ErrBoundary><PracticeApp /></ErrBoundary>
);
