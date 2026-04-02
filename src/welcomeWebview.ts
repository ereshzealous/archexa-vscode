import * as vscode from "vscode";
import { getNonce } from "./utils/platform.js";

export class WelcomeWebview {
  private static panel: vscode.WebviewPanel | undefined;

  static show(ctx: vscode.ExtensionContext): void {
    if (WelcomeWebview.panel) {
      WelcomeWebview.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "archexa.welcome",
      "Archexa",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
      }
    );

    WelcomeWebview.panel = panel;
    panel.onDidDispose(() => { WelcomeWebview.panel = undefined; });

    const cssUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, "media", "welcome.css")
    );
    const iconUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, "media", "archexa-icon.svg")
    );

    const cfg = vscode.workspace.getConfiguration("archexa");
    const version = cfg.get<string>("binaryVersion") ?? "beta";
    const nonce = getNonce();

    panel.webview.html = buildHtml(panel.webview, cssUri, iconUri, version, nonce);

    panel.webview.onDidReceiveMessage((msg: { type: string }) => {
      switch (msg.type) {
        case "openSettings":
          void vscode.commands.executeCommand("archexa.openSettings");
          break;
        case "openSidebar":
          void vscode.commands.executeCommand("workbench.view.extension.archexa-sidebar");
          break;
        case "runGist":
          void vscode.commands.executeCommand("archexa.gist");
          break;
      }
    });
  }

  static showIfFirstTime(ctx: vscode.ExtensionContext): void {
    if (!ctx.globalState.get<boolean>("archexa.welcomeShown")) {
      WelcomeWebview.show(ctx);
      void ctx.globalState.update("archexa.welcomeShown", true);
    }
  }
}

function buildHtml(
  webview: vscode.Webview,
  cssUri: vscode.Uri,
  iconUri: vscode.Uri,
  version: string,
  nonce: string
): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>

  <div class="hero">
    <img class="hero-icon" src="${iconUri}" alt="Archexa"/>
    <div class="hero-title">Archexa</div>
    <div class="hero-subtitle">AI-powered codebase intelligence for VS Code</div>
    <span class="hero-badge">v${version.replace(/^v/, "")} BETA</span>
  </div>

  <!-- Tabs -->
  <div class="tab-bar">
    <button class="tab active" data-tab="about">About</button>
    <button class="tab" data-tab="features">Features</button>
    <button class="tab" data-tab="start">Getting Started</button>
    <button class="tab" data-tab="changelog">Changelog</button>
  </div>

  <!-- About -->
  <div class="tab-content active" id="tab-about">
    <div class="privacy-banner">
      <div class="privacy-title">Your code stays private</div>
      <div class="privacy-text">
        Archexa runs entirely on your machine. The binary scans your code locally using
        AST parsing and pattern matching. Only LLM prompts are sent to the API endpoint
        you configure (OpenAI, OpenRouter, Ollama, etc). No code is sent to Archexa servers.
        No telemetry. No account required.
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">What is Archexa?</div>
      <p>Archexa is an AI-powered developer tool that understands your codebase at the architecture level. It uses tree-sitter AST parsing to extract structural evidence, then combines it with LLM reasoning to deliver insights no linter or static analyzer can provide.</p>
      <p>Unlike ChatGPT or Copilot, Archexa doesn't just look at the file you're editing. It traces callers, follows imports, checks both sides of interfaces, and investigates cross-file relationships.</p>
    </div>

    <div class="content-section">
      <div class="section-title">How It Works</div>
      <div class="how-steps">
        <div class="how-step">
          <div class="how-num">1</div>
          <div class="how-body">
            <strong>Scan</strong> — The binary scans your repo using tree-sitter AST parsing, extracting imports, function signatures, class hierarchies, and call patterns.
          </div>
        </div>
        <div class="how-step">
          <div class="how-num">2</div>
          <div class="how-body">
            <strong>Investigate</strong> (deep mode) — The LLM reads specific files, greps for patterns, traces callers, and follows data flow. Like a senior engineer exploring the codebase.
          </div>
        </div>
        <div class="how-step">
          <div class="how-num">3</div>
          <div class="how-body">
            <strong>Synthesize</strong> — Evidence from scanning and investigation is assembled into a context-optimized prompt, then the LLM generates the final output with citations.
          </div>
        </div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Supported Languages</div>
      <p class="lang-list">Python, TypeScript, JavaScript, Go, Java, Rust, Ruby, C#, Kotlin, Scala, C++, C, PHP</p>
    </div>
  </div>

  <!-- Features -->
  <div class="tab-content" id="tab-features">
    <div class="features">
      <div class="feature-card">
        <div class="feature-title">Diagnose Errors</div>
        <div class="feature-desc">Select an error, stack trace, or log file. Archexa correlates it with your codebase to find the root cause. Supports time-filtered log analysis.</div>
        <div class="feature-shortcut">Cmd+Shift+D</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Code Review</div>
        <div class="feature-desc">Cross-file architecture-aware review. Finds security issues, resource leaks, and interface mismatches that linters miss. Review files, uncommitted changes, or branch diffs.</div>
        <div class="feature-shortcut">Cmd+Shift+R</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Query Codebase</div>
        <div class="feature-desc">Ask any question about your code. "How does auth work?" "Where are database queries?" The LLM reads files and traces flows to answer.</div>
        <div class="feature-shortcut">Cmd+Alt+Q</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Impact Analysis</div>
        <div class="feature-desc">What breaks if this file changes? Traces dependencies, callers, and interface contracts to predict downstream impact before you ship.</div>
        <div class="feature-shortcut">Cmd+Shift+I</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Quick Gist</div>
        <div class="feature-desc">Get a fast overview of any codebase. Tech stack, how things connect, key modules, developer quick start. Great for onboarding.</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Full Architecture</div>
        <div class="feature-desc">Comprehensive architecture documentation. Multi-phase analysis with AST parsing, evidence extraction, and LLM synthesis. Commit-ready markdown.</div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Deep Mode</div>
      <p>Every command supports deep mode — an agentic investigation where the LLM reads files, greps for patterns, traces callers, and iterates before generating output. It's like having a senior engineer explore your codebase before answering.</p>
      <p>Deep mode uses 3-10x more tokens but finds cross-file issues that pipeline mode misses. Configure it globally in Settings or per-command.</p>
    </div>

    <div class="content-section">
      <div class="section-title">Inline Findings</div>
      <p>Review findings appear as squiggles in the editor (red for errors, yellow for warnings, blue for info) and in the VS Code Problems panel, just like TypeScript or ESLint diagnostics.</p>
    </div>
  </div>

  <!-- Getting Started -->
  <div class="tab-content" id="tab-start">
    <div class="setup-section">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <div class="step-title">Configure your LLM provider</div>
          <div class="step-desc">Set your API key, base URL, and model. Any OpenAI-compatible endpoint works — OpenAI, OpenRouter, Anthropic (via proxy), Ollama, vLLM, LiteLLM.</div>
          <button class="step-action primary" id="btnSettings">Open Settings</button>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <div class="step-title">Open a project</div>
          <div class="step-desc">Open any codebase folder in VS Code. Archexa creates an <code>archexa.yaml</code> config file in your workspace root with your settings.</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <div class="step-title">Run your first command</div>
          <div class="step-desc">Click the Archexa icon in the activity bar to open the sidebar. Or right-click any file in the explorer.</div>
          <button class="step-action" id="btnSidebar">Open Sidebar</button>
          <button class="step-action" id="btnGist" style="margin-left:6px">Try Quick Gist</button>
        </div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Keyboard Shortcuts</div>
      <div class="shortcuts">
        <div class="shortcut-row"><span>Diagnose selected error</span><span class="shortcut-key">Cmd+Shift+D</span></div>
        <div class="shortcut-row"><span>Review current file</span><span class="shortcut-key">Cmd+Shift+R</span></div>
        <div class="shortcut-row"><span>Query codebase</span><span class="shortcut-key">Cmd+Alt+Q</span></div>
        <div class="shortcut-row"><span>Impact analysis</span><span class="shortcut-key">Cmd+Shift+I</span></div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Requirements</div>
      <ul class="req-list">
        <li>VS Code 1.85 or later</li>
        <li>An OpenAI-compatible API key (OpenAI, OpenRouter, etc.)</li>
        <li>Internet connection (for LLM API calls only — scanning is offline)</li>
        <li>No Python, pip, or other runtime needed — the binary is self-contained</li>
      </ul>
    </div>
  </div>

  <!-- Changelog -->
  <div class="tab-content" id="tab-changelog">
    <div class="content-section">
      <div class="changelog-entry">
        <div class="changelog-version">v0.3.0-beta <span class="changelog-date">April 2026</span></div>
        <ul>
          <li>Real-time streaming output (--stdout flag)</li>
          <li>Added Quick Gist and Full Architecture commands</li>
          <li>Sidebar redesigned as webview with SVG icons</li>
          <li>Connection test sends real chat completion request</li>
          <li>Settings auto-sync to archexa.yaml</li>
          <li>Cancel immediately kills process (SIGTERM + SIGKILL fallback)</li>
          <li>Version update notifications via version.json manifest</li>
          <li>35 unit tests</li>
        </ul>
      </div>

      <div class="changelog-entry">
        <div class="changelog-version">v0.2.0-beta <span class="changelog-date">March 2026</span></div>
        <ul>
          <li>Initial VS Code extension with diagnose, review, query, impact</li>
          <li>Auto-download binary from GitHub Releases</li>
          <li>Onboarding setup wizard</li>
          <li>Settings webview with 8 sections</li>
          <li>Inline diagnostic squiggles for review findings</li>
        </ul>
      </div>

      <div class="changelog-entry">
        <div class="changelog-version">v0.1.0-alpha <span class="changelog-date">February 2026</span></div>
        <ul>
          <li>Proof of concept — CLI wrapper with basic webview output</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="welcome-footer">
    Archexa is open source under the Apache 2.0 license.<br/>
    github.com/ereshzealous/archexa
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    document.getElementById("btnSettings").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "openSettings" });
    });
    document.getElementById("btnSidebar").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "openSidebar" });
    });
    document.getElementById("btnGist").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "runGist" });
    });

    // Tab switching
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("tab-" + tab.getAttribute("data-tab")).classList.add("active");
      });
    });
  </script>
</body>
</html>`;
}
