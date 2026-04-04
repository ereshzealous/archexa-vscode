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

    const extVersion = ctx.extension.packageJSON.version as string ?? "0.1.0";
    const nonce = getNonce();
    const isMac = process.platform === "darwin";

    panel.webview.html = buildHtml(panel.webview, cssUri, iconUri, extVersion, nonce, isMac);

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
  nonce: string,
  isMac: boolean
): string {
  const mod = isMac ? "Cmd" : "Ctrl";
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
        tree-sitter AST parsing. Only LLM prompts (containing code context) are sent to the
        API endpoint you configure. No code is sent to Archexa servers.
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
            <strong>Scan</strong> — Tree-sitter AST parsing extracts imports, function signatures, class hierarchies, and call patterns.
          </div>
        </div>
        <div class="how-step">
          <div class="how-num">2</div>
          <div class="how-body">
            <strong>Investigate</strong> (deep mode) — The LLM reads specific files, greps for patterns, traces callers, and follows data flow across your codebase.
          </div>
        </div>
        <div class="how-step">
          <div class="how-num">3</div>
          <div class="how-body">
            <strong>Synthesize</strong> — Evidence is assembled into a context-optimized prompt. The LLM generates the final output with file references and citations.
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
        <div class="feature-title">Review</div>
        <div class="feature-desc">Cross-file architecture-aware code review with inline findings (squiggles). Review files, uncommitted changes, or branch diffs.</div>
        <div class="feature-shortcut">${mod}+Shift+R</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Diagnose</div>
        <div class="feature-desc">Root-cause errors from selection, clipboard, or log files. Traces call chains and reads surrounding code to find the cause.</div>
        <div class="feature-shortcut">${mod}+Shift+D</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Impact</div>
        <div class="feature-desc">What breaks if this file changes? Traces callers, consumers, and interface contracts to predict downstream impact.</div>
        <div class="feature-shortcut">${mod}+Shift+I</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Query</div>
        <div class="feature-desc">Ask any question about your codebase. The LLM reads files and traces flows to answer with evidence.</div>
        <div class="feature-shortcut">${mod}+Alt+Q</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Gist</div>
        <div class="feature-desc">Quick codebase overview: tech stack, key modules, how things connect. Great for onboarding to new projects.</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Analyze</div>
        <div class="feature-desc">Full architecture documentation with multi-phase AST analysis. Produces commit-ready markdown with diagrams.</div>
      </div>
      <div class="feature-card">
        <div class="feature-title">Explain This</div>
        <div class="feature-desc">Right-click any selection to understand what it does, why it exists, and how it connects to the rest of the codebase.</div>
        <div class="feature-shortcut">Right-click &gt; Archexa &gt; Explain</div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Deep Mode</div>
      <p>Every command supports deep mode — an agentic investigation where the LLM reads files, greps for patterns, traces callers, and iterates before generating output.</p>
      <p>Deep mode uses more tokens but finds cross-file issues that pipeline mode misses. Configure it globally in Settings &gt; Behaviour.</p>
    </div>

    <div class="content-section">
      <div class="section-title">Inline Findings</div>
      <p>Review findings appear as squiggles in the editor and in the VS Code Problems panel, just like TypeScript or ESLint diagnostics. Errors are red, warnings are yellow, info is blue.</p>
    </div>
  </div>

  <!-- Getting Started -->
  <div class="tab-content" id="tab-start">
    <div class="setup-section">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <div class="step-title">Configure your LLM provider</div>
          <div class="step-desc">Set your API key, base URL, and model in Settings &gt; Connection. Any OpenAI-compatible endpoint works &mdash; OpenAI, OpenRouter, Ollama, vLLM, LiteLLM, etc.</div>
          <button class="step-action primary" id="btnSettings">Open Settings</button>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <div class="step-title">Open a project</div>
          <div class="step-desc">Open any codebase folder in VS Code. Your settings are synced automatically &mdash; no manual config files needed.</div>
        </div>
      </div>

      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <div class="step-title">Run your first command</div>
          <div class="step-desc">Click the Archexa icon in the activity bar to open the sidebar, or right-click any file in the explorer. Try a Quick Gist to see an overview of your codebase.</div>
          <button class="step-action" id="btnSidebar">Open Sidebar</button>
          <button class="step-action" id="btnGist" style="margin-left:6px">Try Quick Gist</button>
        </div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Keyboard Shortcuts</div>
      <div class="shortcuts">
        <div class="shortcut-row"><span>Diagnose selected error</span><span class="shortcut-key">${mod}+Shift+D</span></div>
        <div class="shortcut-row"><span>Review current file</span><span class="shortcut-key">${mod}+Shift+R</span></div>
        <div class="shortcut-row"><span>Query codebase</span><span class="shortcut-key">${mod}+Alt+Q</span></div>
        <div class="shortcut-row"><span>Impact analysis</span><span class="shortcut-key">${mod}+Shift+I</span></div>
      </div>
    </div>

    <div class="content-section">
      <div class="section-title">Requirements</div>
      <ul class="req-list">
        <li>VS Code 1.85 or later</li>
        <li>An OpenAI-compatible API key (OpenAI, OpenRouter, Ollama, etc.)</li>
        <li>Internet connection for LLM API calls only &mdash; scanning is fully offline</li>
        <li>No Python, pip, or other runtime needed &mdash; the binary is self-contained (~20 MB)</li>
      </ul>
    </div>
  </div>

  <!-- Changelog -->
  <div class="tab-content" id="tab-changelog">
    <div class="content-section">
      <div class="changelog-entry">
        <div class="changelog-version">v0.1.0 <span class="changelog-date">April 2026</span></div>
        <ul>
          <li>Unified sidebar with chat, settings, and history in a single webview</li>
          <li>Two-step command wizard: grouped slash menu + per-command input forms</li>
          <li>Seven AI commands: Review, Diagnose, Impact, Query, Gist, Analyze, Explain This</li>
          <li>Real-time streaming output with live agent step display</li>
          <li>File autocomplete with <code>git ls-files</code> integration</li>
          <li>Collapsible chat history with accordion UI</li>
          <li>Settings panel with Connect, Behaviour, Prompts, and Advanced tabs</li>
          <li>Inline review findings as editor squiggles (VS Code Problems panel)</li>
          <li>Auto-download binary from GitHub Releases with SHA256 verification</li>
          <li>Connection test (sends real chat/completions request)</li>
          <li>Multi-file review and impact analysis (explorer multi-select)</li>
          <li>Review uncommitted changes and branch diffs</li>
          <li>Custom prompts per command</li>
          <li>History with date groups (Today, Yesterday, etc.)</li>
          <li>Platform-aware keyboard shortcuts (${mod} on ${isMac ? "macOS" : "Windows/Linux"})</li>
        </ul>

        <div class="changelog-sub">Security</div>
        <ul>
          <li>XSS prevention: HTML escaping on all dynamic values</li>
          <li>Shell injection prevention: <code>execFileSync</code> over <code>execSync</code></li>
          <li>API key never sent to webview (masked display only)</li>
          <li>Binary downloads restricted to HTTPS GitHub CDN hosts</li>
          <li>SHA256 checksum verification for downloaded binaries</li>
        </ul>

        <div class="changelog-sub">Supported Platforms</div>
        <ul>
          <li>macOS (Apple Silicon, Intel)</li>
          <li>Linux (x86_64, arm64)</li>
          <li>Windows (x64)</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="welcome-footer">
    Apache 2.0 License
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
