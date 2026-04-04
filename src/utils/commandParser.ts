/**
 * Command parsing and intent detection — extracted from sidebarProvider.ts
 * for modularity and testability.
 */
import * as path from "path";

export interface ParsedCommand {
  command: string;
  cliCommand: string;
  args: string[];
  label: string;
  icon: string;
}

/**
 * Detect user intent from free-text input.
 * Returns a command name or null if no intent detected.
 */
export function detectIntent(text: string): string | null {
  const s = text.toLowerCase();
  if (/\berror\b|exception|failing|crash|why is|traceback|not work|decode|typeerror|stacktrace/.test(s)) return "diagnose";
  if (/\breview\b|check|securi|bug|vulnerab|\bsql\b|jwt|audit|issues?\b/.test(s)) return "review";
  if (/\bexplain\b|what (does|is)|how does|understand|purpose|walk me/.test(s)) return "query";
  if (/\bimpact\b|what breaks|what happens if|change|affect|downstream/.test(s)) return "impact";
  return null;
}

/**
 * Parse a slash command or free-text input into a structured command.
 * @param text The user input text
 * @param currentFile Optional relative path of the currently open file
 */
export function parseCommand(text: string, currentFile?: string): ParsedCommand {
  if (text.startsWith("/review")) {
    const rest = text.slice(7).trim();
    if (rest === "--changed" || rest === "changes" || rest === "changed") {
      return { command: "review", cliCommand: "review", args: ["--changed"], label: "Review Changes", icon: "search" };
    }
    if (rest.startsWith("--")) return { command: "review", cliCommand: "review", args: rest.split(/\s+/), label: "Review", icon: "search" };
    if (rest) {
      // Split into positional target and any flags (e.g. "--focus security", "--branch main")
      const flagIdx = rest.indexOf(" --");
      const targetPart = flagIdx >= 0 ? rest.slice(0, flagIdx).trim() : rest;
      const flagPart = flagIdx >= 0 ? rest.slice(flagIdx).trim() : "";
      const files = targetPart.split(",").map(f => f.trim()).filter(Boolean);
      const args = files.length > 0 ? ["--target", files.join(",")] : [];
      if (flagPart) args.push(...flagPart.split(/\s+/));
      const label = files.length > 1
        ? `Review ${files.length} files`
        : files.length === 1 ? `Review ${path.basename(files[0])}` : "Review";
      return { command: "review", cliCommand: "review", args, label, icon: "search" };
    }
    return currentFile
      ? { command: "review", cliCommand: "review", args: ["--target", currentFile], label: `Review ${path.basename(currentFile)}`, icon: "search" }
      : { command: "review", cliCommand: "review", args: [], label: "Review", icon: "search" };
  }
  if (text.startsWith("/impact")) {
    const rest = text.slice(7).trim();
    if (rest.startsWith("--")) return { command: "impact", cliCommand: "impact", args: rest.split(/\s+/), label: "Impact", icon: "zap" };
    const parts = rest.split(/\s+/);
    const target = parts[0] || currentFile || "";
    const query = parts.slice(1).join(" ");
    const args = target ? ["--target", target] : [];
    if (query) args.push("--query", query);
    const targetFiles = target.split(",").filter(Boolean);
    const impactLabel = targetFiles.length > 1
      ? `Impact ${targetFiles.length} files`
      : `Impact ${target ? path.basename(target) : ""}`;
    return { command: "impact", cliCommand: "impact", args, label: impactLabel, icon: "zap" };
  }
  if (text.startsWith("/diagnose")) {
    const rest = text.slice(9).trim();
    return rest
      ? { command: "diagnose", cliCommand: "diagnose", args: ["--error", rest.slice(0, 3000)], label: "Diagnose", icon: "bug" }
      : { command: "diagnose", cliCommand: "diagnose", args: [], label: "Diagnose", icon: "bug" };
  }
  if (text.startsWith("/gist")) {
    const rest = text.slice(5).trim();
    return { command: "gist", cliCommand: "gist", args: rest ? ["--query", rest] : [], label: "Gist", icon: "book" };
  }
  if (text.startsWith("/analyze")) {
    const rest = text.slice(8).trim();
    return { command: "analyze", cliCommand: "analyze", args: rest ? ["--query", rest] : [], label: "Analyze", icon: "graph" };
  }
  if (text.startsWith("/query")) {
    const rest = text.slice(6).trim();
    return { command: "query", cliCommand: "query", args: ["--query", rest || text], label: "Query", icon: "comment" };
  }

  const intent = detectIntent(text);
  if (intent === "diagnose") {
    return { command: "diagnose", cliCommand: "diagnose", args: ["--error", text.slice(0, 3000)], label: "Diagnose", icon: "bug" };
  }
  if (intent === "review") {
    return currentFile
      ? { command: "review", cliCommand: "review", args: ["--target", currentFile], label: `Review ${path.basename(currentFile)}`, icon: "search" }
      : { command: "query", cliCommand: "query", args: ["--query", text], label: "Query", icon: "comment" };
  }
  if (intent === "impact") {
    const args = currentFile ? ["--target", currentFile, "--query", text] : ["--query", text];
    return { command: currentFile ? "impact" : "query", cliCommand: currentFile ? "impact" : "query", args, label: currentFile ? `Impact ${path.basename(currentFile)}` : "Query", icon: currentFile ? "zap" : "comment" };
  }

  return { command: "query", cliCommand: "query", args: ["--query", text], label: "Query", icon: "comment" };
}
