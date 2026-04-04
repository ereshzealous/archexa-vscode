# Archexa (Beta) — AI-Powered Codebase Intelligence

> Diagnose errors, review code, query architecture, and trace impact — all powered by a self-contained binary with deep agentic investigation.

![Archexa sidebar demo](media/screenshots/sidebar-demo.gif)

---

## Features

| Command | What it does | Shortcut |
|---------|-------------|----------|
| **Review** | Cross-file architecture-aware code review with inline findings (squiggles) | `Cmd+Shift+R` / `Ctrl+Shift+R` |
| **Diagnose** | Root-cause errors from selection, clipboard, or log files | `Cmd+Shift+D` / `Ctrl+Shift+D` |
| **Impact** | What breaks if this file changes? Traces callers and contracts | `Cmd+Shift+I` / `Ctrl+Shift+I` |
| **Query** | Ask any question about your codebase with evidence-backed answers | `Cmd+Alt+Q` / `Ctrl+Shift+Q` |
| **Gist** | Quick codebase overview: tech stack, key modules, how things connect | Sidebar |
| **Analyze** | Full architecture documentation with multi-phase AST analysis | Sidebar |
| **Explain** | Right-click any selection to understand what it does and why | Right-click > Archexa |

---

## Review Findings

Review findings appear as **inline squiggles** in the editor and in the VS Code **Problems panel**, just like TypeScript or ESLint diagnostics.

![Review findings with inline squiggles](media/screenshots/review-findings.png)

---

## How It Works

1. **Scan** — Tree-sitter AST parsing extracts imports, signatures, call patterns
2. **Investigate** (deep mode) — The LLM reads files, greps patterns, traces callers
3. **Synthesize** — Evidence is assembled into a context-optimized prompt for the final output

---

## Quick Start

1. Install the extension from the VS Code Marketplace
2. The setup wizard downloads the Archexa binary automatically (~20 MB, no Python required)
3. Set your API key in **Settings > Connection** (any OpenAI-compatible endpoint)
4. Right-click any file > **Archexa**, or use keyboard shortcuts

![Settings panel](media/screenshots/settings.png)

---

## Sidebar

The unified sidebar provides:

- **Command wizard** — Two-step flow: pick a command, then fill in the form (files, focus, error text)
- **Chat** — Streaming results with live agent steps and collapsible message history
- **Settings** — Connection, Behaviour, Prompts, and Advanced tabs
- **History** — Recent results with date groups, clickable to reopen

---

## Gist & Architecture Output

Run **Gist** for a quick overview or **Analyze** for full architecture documentation with Mermaid diagrams.

![Gist output](media/screenshots/gist-output.png)

---

## Deep Mode

Every command supports **deep mode** — an agentic investigation where the LLM reads files, greps for patterns, traces callers, and iterates before generating output.

Deep mode finds cross-file issues that pipeline mode misses. Toggle it in **Settings > Behaviour**.

---

## Supported Languages

Python, TypeScript, JavaScript, Go, Java, Rust, Ruby, C#, Kotlin, Scala, C++, C, PHP

---

## Requirements

- VS Code 1.85+
- An OpenAI-compatible API key (OpenAI, OpenRouter, Ollama, vLLM, LiteLLM, etc.)
- Internet connection for LLM API calls only — scanning is fully offline

---

## Settings

Open **Archexa: Open Settings** from the command palette, or configure via VS Code settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `archexa.apiKey` | API key (or set `OPENAI_API_KEY` env var) | — |
| `archexa.model` | LLM model | `gpt-4o` |
| `archexa.endpoint` | API base URL | `https://api.openai.com/v1/` |
| `archexa.deepByDefault` | Use agentic deep mode by default | `true` |
| `archexa.showInlineFindings` | Show review findings as editor squiggles | `true` |
| `archexa.excludePatterns` | Glob patterns to exclude from scanning | `.archexa/**` |

See all settings in **Settings > Advanced**.

---

## Privacy

Archexa runs entirely on your machine. The binary scans your code locally using AST parsing. Only LLM prompts (containing code context) are sent to the API endpoint you configure. No code is sent to Archexa servers. No telemetry. No account required.

---

## License

Apache 2.0
