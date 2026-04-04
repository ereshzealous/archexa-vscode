# Archexa Usage Guide

Complete reference for the Archexa VS Code extension.

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
  - [Review](#review)
  - [Diagnose](#diagnose)
  - [Impact](#impact)
  - [Query](#query)
  - [Gist](#gist)
  - [Analyze](#analyze)
  - [Explain This](#explain-this)
- [Sidebar](#sidebar)
- [Deep Mode](#deep-mode)
- [Custom Prompts](#custom-prompts)
- [Inline Findings](#inline-findings)
- [File & Directory Structure](#file--directory-structure)
- [Settings Reference](#settings-reference)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Supported LLM Providers](#supported-llm-providers)
- [Troubleshooting](#troubleshooting)

---

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Press `Cmd+Shift+X` (macOS) or `Ctrl+Shift+X` (Windows/Linux)
3. Search for **"Archexa"**
4. Click **Install**

### First-Time Setup

On first activation, the setup wizard downloads the Archexa binary (~20 MB). The binary is self-contained — no Python, pip, or other runtime needed.

The binary is stored at:
```
~/.vscode/globalStorage/<publisher>.archexa/bin/archexa
```

### Manual Binary Path

If you download the binary manually, set the path in VS Code settings:
```json
"archexa.binaryPath": "/path/to/archexa"
```

---

## Configuration

### Connection Setup

1. Open the Archexa sidebar (click the icon in the activity bar)
2. Click **Settings** (gear icon in the title bar)
3. Go to the **Connection** tab
4. Set your **API key**, **endpoint**, and **model**
5. Click **Test Connection** to verify
6. Click **Save**

### API Key

Set your API key in one of two ways:

- **Settings UI** — Enter in Settings > Connection > API Key
- **Environment variable** — Set `OPENAI_API_KEY` in your shell profile

The API key is never sent to the webview or stored in config files. It is passed to the CLI via environment variable only.

### Config File

Your settings are saved to `.archexa/config.yaml` in your project root. This file is auto-generated from the Settings UI — do not edit it manually.

If you prefer to manage config manually, create an `archexa.yaml` in your project root. The extension will use it as a fallback (but will not overwrite it).

**Priority order:**
1. `.archexa/config.yaml` (extension-managed, from Settings UI)
2. `archexa.yaml` in project root (user-managed)
3. `.archexa.yaml` in project root (user-managed, hidden)
4. Auto-generated from VS Code settings

---

## Commands

### Review

**What it does:** Cross-file architecture-aware code review. Finds security issues, resource leaks, interface mismatches, and logic errors that linters miss.

**How to use:**

| Method | Steps |
|--------|-------|
| Keyboard shortcut | `Cmd+Shift+R` / `Ctrl+Shift+R` (reviews current file) |
| Right-click file | Explorer > Right-click > Archexa > Review This File |
| Right-click multiple files | Select files in Explorer > Right-click > Archexa > Review |
| Sidebar | Click **Review** card > select files > optionally set focus > Send |
| Review changes | Sidebar > Review > Changed files tab (reviews uncommitted changes) |
| Review branch | Sidebar > Review > Branch tab > enter branch name |

**Focus filter:** Optionally narrow the review to specific areas like `security`, `performance`, `error handling`, etc.

**Output:** Markdown with findings. Each finding is also shown as an inline squiggle in the editor.

---

### Diagnose

**What it does:** Root-cause analysis for errors. Traces call chains, reads surrounding code, and correlates with your codebase.

**How to use:**

| Method | Steps |
|--------|-------|
| Keyboard shortcut | Select error text > `Cmd+Shift+D` / `Ctrl+Shift+D` |
| Clipboard | `Cmd+Shift+P` > "Archexa: Diagnose from Clipboard" |
| Log file | Right-click `.log` file in Explorer > Archexa > Diagnose Log File |
| Sidebar | Click **Diagnose** card > paste error/stack trace > Send |

**Input:** Any error message, stack trace, exception, or log excerpt. The more context you provide, the better the diagnosis.

---

### Impact

**What it does:** Predicts what breaks if a file changes. Traces callers, consumers, interface contracts, and dependency chains.

**How to use:**

| Method | Steps |
|--------|-------|
| Keyboard shortcut | Open a file > `Cmd+Shift+I` / `Ctrl+Shift+I` |
| Right-click | Explorer > Right-click > Archexa > Impact: What Breaks? |
| Sidebar | Click **Impact** card > add files > optionally describe the change > Send |

**Input:** One or more files you plan to modify. Optionally describe the change (e.g., "removing the subprocess approach, switching to REST API").

---

### Query

**What it does:** Ask any question about your codebase. The LLM reads files and traces flows to answer with evidence.

**How to use:**

| Method | Steps |
|--------|-------|
| Keyboard shortcut | `Cmd+Alt+Q` / `Ctrl+Shift+Q` |
| Sidebar | Click **Query** or type your question in the chat input |

**Examples:**
- "How does authentication work?"
- "Where are database queries executed?"
- "What's the request lifecycle?"
- "How is caching implemented?"

The LLM will read relevant files, follow imports, and provide an evidence-backed answer with file references.

---

### Gist

**What it does:** Quick codebase overview — tech stack, key modules, how things connect.

**How to use:**

| Method | Steps |
|--------|-------|
| Sidebar | Click **Gist** card > optionally enter focus area > Run |
| Command palette | `Cmd+Shift+P` > "Archexa: Quick Gist of Codebase" |

**Custom prompt:** Set a custom Gist prompt in Settings > Prompts > Gist to control the output format (e.g., request Mermaid diagrams, focus on specific areas).

---

### Analyze

**What it does:** Full architecture documentation with multi-phase AST analysis. Produces comprehensive markdown suitable for committing to your repo.

**How to use:**

| Method | Steps |
|--------|-------|
| Sidebar | Click **Analyze** card > optionally enter focus area > Run |
| Right-click | Explorer > Right-click > Archexa > Full Architecture Analysis |

**Output:** Detailed markdown covering modules, dependencies, data flow, entry points, and architecture patterns.

---

### Explain This

**What it does:** Explains what a code selection does, why it exists, and how it connects to the rest of the codebase.

**How to use:**

1. Select code in the editor
2. Right-click > **Archexa > Explain This**

---

## Sidebar

The sidebar is the primary interface. It has three main screens:

### Home Screen

- **Status card** — Shows connection status, model, and binary version
- **Command cards** — Review, Diagnose, Impact (click to open command forms)
- **More actions** — Gist, Analyze, Query, Explain
- **Recent Results** — Clickable history with date groups

### Chat Screen

- **Streaming output** — Results appear in real-time as the LLM generates them
- **Agent steps** — Expandable section showing what files the agent read and what tools it used
- **Collapsible messages** — Each result is a collapsible accordion with a header bar
- **Copy / Save** — Copy result to clipboard or save as markdown file

### Settings Screen

Four tabs:

| Tab | What it configures |
|-----|--------------------|
| **Connection** | API key, endpoint URL, model, TLS verification |
| **Behaviour** | Deep mode, cache, token usage, inline findings |
| **Prompts** | Custom prompt per command (Diagnose, Review, Query, Impact, Gist, Analyze) |
| **Advanced** | Output directory, limits, exclusion patterns, log level |

---

## Deep Mode

Deep mode enables agentic investigation. Instead of a single LLM call, the agent:

1. Reads files relevant to your query
2. Greps for patterns and symbols
3. Traces callers and call chains
4. Iterates multiple times (configurable, default 15 iterations max)
5. Synthesizes all evidence into the final output

### When to use deep mode

| Scenario | Recommendation |
|----------|----------------|
| Quick question about a single file | Deep mode off |
| Cross-file architecture question | Deep mode on |
| Security review | Deep mode on |
| Quick gist for orientation | Deep mode off |
| Full architecture documentation | Deep mode on |

### Configuration

- **Toggle globally:** Settings > Behaviour > Deep mode by default
- **Max iterations:** Settings > Advanced > `archexa.deepMaxIterations` (3-30, default 15)

---

## Custom Prompts

Each command has a custom prompt field in Settings > Prompts. The text you enter is appended to the command's system prompt, allowing you to customize behavior.

### Examples

**Review prompt:**
```
Focus on security: SQL injection, XSS, auth bypass. Ignore style and formatting.
```

**Gist prompt:**
```
Include Mermaid diagrams for architecture and data flow. Structure output with:
1. Project Overview
2. Tech Stack (table)
3. Architecture (Mermaid graph TD)
4. Data Flow (Mermaid sequenceDiagram)
5. Key Modules
```

**Diagnose prompt:**
```
Our logs use structlog JSON format. The app runs on Kubernetes.
```

### Prompt editor

Click the pencil icon next to any prompt to open the full-screen editor. Markdown is supported.

---

## Inline Findings

When you run a **Review**, findings are displayed in two places:

1. **Editor squiggles** — Red (error), yellow (warning), blue (info) underlines on the affected lines
2. **Problems panel** — `Cmd+Shift+M` / `Ctrl+Shift+M` to view all findings

### Controls

| Setting | Effect |
|---------|--------|
| `archexa.showInlineFindings` | Enable/disable squiggles |
| `archexa.clearFindingsOnNewReview` | Clear old findings when starting a new review |
| **Clear All Findings** command | `Cmd+Shift+P` > "Archexa: Clear All Findings" |

---

## File & Directory Structure

Archexa creates two directories in your project:

```
your-project/
  .archexa/                      ← extension-managed
    config.yaml                  ← config synced from Settings UI
    ARCHITECTURE_DOC_*.md        ← generated output files
    review_*.md
    gist_*.md
  .archexa_cache/                ← CLI-managed
    *.json                       ← tree-sitter AST cache
```

### .gitignore

On first activation, the extension prompts you to add these to `.gitignore`. If you prefer to do it manually:

```gitignore
# Archexa (AI codebase intelligence)
.archexa/
.archexa_cache/
```

### Output directory

The default output directory is `.archexa/`. To change it:

- **Settings UI:** Settings > Advanced > Output directory
- **VS Code settings:** `"archexa.outputDir": "docs/archexa"`

### User-managed config

If you want to manage the CLI config manually (e.g., for CI pipelines), create `archexa.yaml` in your project root. The extension will not overwrite it. However, if you also change settings through the UI, the extension's `.archexa/config.yaml` takes priority at runtime.

---

## Settings Reference

### Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `archexa.apiKey` | string | `""` | API key. Leave empty to use `OPENAI_API_KEY` env var |
| `archexa.model` | string | `"gpt-4o"` | Model name as your provider expects it |
| `archexa.endpoint` | string | `"https://api.openai.com/v1/"` | API base URL |
| `archexa.tlsVerify` | boolean | `true` | Verify TLS certificates |

### Behaviour

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `archexa.deepByDefault` | boolean | `true` | Use deep (agentic) mode by default |
| `archexa.deepMaxIterations` | number | `15` | Max agent iterations (3-30) |
| `archexa.cacheEnabled` | boolean | `true` | Cache tree-sitter results between runs |
| `archexa.showInlineFindings` | boolean | `true` | Show review findings as editor squiggles |
| `archexa.clearFindingsOnNewReview` | boolean | `true` | Clear previous findings on new review |
| `archexa.showTokenUsage` | boolean | `true` | Show token usage in result metadata |
| `archexa.autoReviewOnSave` | boolean | `false` | Auto-run quick review on file save |

### Prompts

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `archexa.promptDiagnose` | string | `""` | Custom instructions for Diagnose |
| `archexa.promptReview` | string | `""` | Custom instructions for Review |
| `archexa.promptQuery` | string | `""` | Custom instructions for Query |
| `archexa.promptImpact` | string | `""` | Custom instructions for Impact |
| `archexa.promptGist` | string | `""` | Custom instructions for Gist |
| `archexa.promptAnalyze` | string | `""` | Custom instructions for Analyze (also applies as base prompt) |

### Advanced

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `archexa.outputDir` | string | `".archexa"` | Directory for generated output files |
| `archexa.binaryPath` | string | `""` | Full path to archexa binary |
| `archexa.promptBudget` | number | `120000` | Max tokens for LLM prompt |
| `archexa.promptReserve` | number | `16000` | Tokens reserved for output |
| `archexa.maxFiles` | number | `100` | Max files selected for analysis |
| `archexa.fileSizeLimit` | number | `300000` | Skip files larger than this (bytes) |
| `archexa.maxHistory` | number | `30` | Max results in sidebar history (5-200) |
| `archexa.logLevel` | string | `"WARNING"` | CLI log verbosity (DEBUG, INFO, WARNING, ERROR) |
| `archexa.excludePatterns` | array | `[".archexa/**", ".archexa_cache/**"]` | Glob patterns to exclude from scanning |
| `archexa.scanFocus` | array | `[]` | Directory prefixes to focus scanning on |
| `archexa.reviewTarget` | string | `""` | Default target for review |

---

## Keyboard Shortcuts

| Shortcut (macOS) | Shortcut (Windows/Linux) | Command |
|------------------|--------------------------|---------|
| `Cmd+Shift+D` | `Ctrl+Shift+D` | Diagnose Selected Error |
| `Cmd+Shift+R` | `Ctrl+Shift+R` | Review This File |
| `Cmd+Alt+Q` | `Ctrl+Shift+Q` | Query Codebase |
| `Cmd+Shift+I` | `Ctrl+Shift+I` | Impact Analysis |

All shortcuts can be customized in VS Code's keyboard shortcuts settings.

---

## Supported LLM Providers

Archexa works with any endpoint that supports the OpenAI `POST /chat/completions` API with streaming.

| Provider | Endpoint | Notes |
|----------|----------|-------|
| **OpenAI** | `https://api.openai.com/v1/` | Default. Use `gpt-4o`, `gpt-4o-mini`, etc. |
| **OpenRouter** | `https://openrouter.ai/api/v1/` | Access 100+ models. Use `anthropic/claude-sonnet-4-20250514`, etc. |
| **Ollama** | `http://localhost:11434/v1/` | Local models. Use `llama3.1`, `codellama`, etc. |
| **vLLM** | `http://localhost:8000/v1/` | Self-hosted inference server |
| **LiteLLM** | `http://localhost:4000/v1/` | Proxy for any provider |
| **Azure OpenAI** | `https://<name>.openai.azure.com/openai/deployments/<model>/` | Azure-hosted models |
| **Together AI** | `https://api.together.xyz/v1/` | Hosted open-source models |

### Recommended Models

| Use case | Model | Why |
|----------|-------|-----|
| Best quality | `gpt-4o` or `claude-sonnet-4-20250514` | Most accurate for architecture analysis |
| Fast + cheap | `gpt-4o-mini` or `gemini-2.5-flash` | Good for quick gists and queries |
| Privacy | `llama3.1` (via Ollama) | Fully local, no data leaves your machine |

---

## Troubleshooting

### "No Archexa binary found"

Run `Cmd+Shift+P` > **"Archexa: Run Setup Wizard"** to download the binary. Or set `archexa.binaryPath` to a manually downloaded binary.

### macOS: Binary blocked by Gatekeeper

macOS quarantines binaries downloaded from the internet. The extension removes the quarantine flag automatically after download. If it still fails:

1. A notification appears with a **"Fix Permissions"** button — click it
2. Or run manually in Terminal:
   ```bash
   xattr -d com.apple.quarantine ~/.vscode/globalStorage/EreshGorantla.archexa/bin/archexa
   ```
3. If you see *"archexa is damaged"* in a macOS dialog, the same `xattr` command fixes it

This is standard for unsigned binaries distributed outside the Mac App Store. Homebrew, VS Code itself, and most CLI tools do the same.

### "No API key set"

Set your API key in Settings > Connection, or set the `OPENAI_API_KEY` environment variable in your shell profile.

### Connection test fails

1. Verify the endpoint URL ends with `/v1/` (or the correct path for your provider)
2. Check that TLS verification is appropriate (disable for local endpoints with self-signed certs)
3. Ensure the model string matches what your provider expects

### Commands produce no output

- Check the **Output** panel (`Cmd+Shift+U` > select "Archexa") for CLI logs
- Set `archexa.logLevel` to `"DEBUG"` for verbose output
- Ensure the workspace has a folder open (Archexa requires a workspace)

### Squiggles not appearing

- Check that `archexa.showInlineFindings` is enabled in Settings > Behaviour
- Squiggles only appear for **Review** commands
- Open the Problems panel (`Cmd+Shift+M`) to verify findings exist

### Stale results in history

Click **Clear** next to "Recent Results" on the home screen, or run `Cmd+Shift+P` > **"Archexa: Clear Result History"**.
