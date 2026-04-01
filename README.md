# Archexa — VS Code Extension

AI-powered codebase intelligence for VS Code. Diagnose errors, review code, query architecture, and trace impact — all powered by a self-contained binary.

## Features

- **Diagnose** — Root-cause errors from selection, clipboard, or log files
- **Review** — Cross-file architecture-aware code review with inline findings
- **Query** — Ask any question about your codebase
- **Impact** — Trace what breaks when a file changes

## Quick Start

1. Install the extension
2. The setup wizard downloads the Archexa binary automatically (no Python required)
3. Set your API key in Settings > Connection
4. Right-click any file > Archexa, or use keyboard shortcuts

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Cmd+Shift+D` | Diagnose Selected Error |
| `Cmd+Shift+R` | Review This File |
| `Cmd+Shift+Q` | Query Codebase |
| `Cmd+Shift+I` | Impact Analysis |

## Requirements

- VS Code 1.85+
- An OpenAI-compatible API key (OpenAI, OpenRouter, Anthropic, Ollama, etc.)

## Settings

Open `Archexa: Open Settings` from the command palette for a full settings UI, or configure via VS Code settings:

- `archexa.apiKey` — API key
- `archexa.model` — LLM model (default: gpt-4o)
- `archexa.endpoint` — API endpoint URL
- `archexa.deepByDefault` — Use agentic mode by default

## License

Apache 2.0
