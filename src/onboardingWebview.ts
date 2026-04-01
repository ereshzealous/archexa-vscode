import * as vscode from "vscode";
import { BinaryManager } from "./binaryManager.js";
import { Logger } from "./utils/logger.js";

export class OnboardingWebview {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly binManager: BinaryManager,
    private readonly logger: Logger
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "archexa.onboarding",
      "Archexa Setup",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.ctx.extensionUri, "media"),
        ],
      }
    );

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "onboarding.css")
    );

    this.panel.webview.html = this.getHtml(cssUri);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Send platform info
    const label = this.binManager.getPlatformLabel();
    const icon = this.binManager.getPlatformIcon();
    const asset = this.binManager.getAssetName();
    const installPath = this.binManager.getInstallPath();

    this.panel.webview.postMessage({
      type: "platform",
      label,
      icon,
      asset,
      size: "~20 MB",
      installPath,
    });

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string }) => {
        switch (msg.type) {
          case "startDownload":
            await this.handleDownload();
            break;
          case "openSettings":
            await vscode.commands.executeCommand("archexa.openSettings");
            break;
          case "getStarted":
            this.panel?.dispose();
            // Reload window so extension picks up the new binary
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
            break;
        }
      },
      undefined,
      this.ctx.subscriptions
    );
  }

  private async handleDownload(): Promise<void> {
    try {
      this.binManager.setProgressCallback((p) => {
        this.panel?.webview.postMessage({
          type: "progress",
          step: p.step,
          pct: p.pct,
          termLine: p.termLine,
        });
      });

      const installedPath = await this.binManager.downloadLatest();

      const version = this.binManager.readCachedVersion();
      this.panel?.webview.postMessage({
        type: "done",
        installPath: installedPath,
        version,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Download failed: ${message}`);
      vscode.window.showErrorMessage(`Archexa download failed: ${message}`, "Try Again")
        .then((choice) => {
          if (choice === "Try Again") {
            void this.handleDownload();
          }
        });
    }
  }

  private getHtml(cssUri: vscode.Uri): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel!.webview.cspSource}; script-src 'nonce-ONBOARD';" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>
  <!-- PHASE 1 — Welcome -->
  <div id="phase1">
    <div class="welcome-logo">🏛️</div>
    <div class="welcome-title">Welcome to Archexa</div>
    <div class="welcome-subtitle">
      AI-powered codebase intelligence for VS Code.<br/>
      Self-contained binary — no Python or pip required.
    </div>

    <div class="platform-card">
      <div class="card-title">Detected Platform</div>
      <div class="platform-info">
        <span class="icon" id="plat-icon">🖥️</span>
        <span id="plat-label">Detecting...</span>
        <span class="auto-tag">auto-detected</span>
      </div>
      <div class="bundle-line">Bundle: <span id="plat-asset">...</span> · <span id="plat-size">...</span></div>
    </div>

    <div class="install-manifest">
      <div class="card-title">What gets installed</div>
      <div class="manifest-item"><span class="mi-icon">📦</span><span class="mi-label">Binary</span><span class="mi-value" id="plat-path">...</span></div>
      <div class="manifest-item"><span class="mi-icon">📄</span><span class="mi-label">Config</span><span class="mi-value">./archexa.yaml (workspace root)</span></div>
      <div class="manifest-item"><span class="mi-icon">💾</span><span class="mi-label">Cache</span><span class="mi-value">.../bin/version.txt</span></div>
      <div class="manifest-item"><span class="mi-icon">≈</span><span class="mi-label"></span><span class="mi-value">20 MB disk space</span></div>
    </div>

    <button class="btn-download" id="downloadBtn">☁ Download &amp; Install Archexa</button>
    <div class="download-note">Downloads from github.com/ereshzealous/archexa · Apache 2</div>
  </div>

  <!-- PHASE 2 — Downloading -->
  <div id="phase2" class="hidden">
    <div class="phase-header">Installing Archexa bundle...</div>
    <div class="phase-subheader">Downloading <span id="dl-asset">...</span> from GitHub</div>

    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-label">
      <span id="dl-version">archexa</span>
      <span id="dl-pct">0%</span>
    </div>

    <div class="phase-steps" id="steps">
      <div class="step done" id="step-platform"><span class="step-icon">✓</span> Detecting platform</div>
      <div class="step pending" id="step-release"><span class="step-icon">○</span> Fetching release info</div>
      <div class="step pending" id="step-download"><span class="step-icon">○</span> Downloading bundle</div>
      <div class="step pending" id="step-verify"><span class="step-icon">○</span> Verifying integrity</div>
      <div class="step pending" id="step-install"><span class="step-icon">○</span> Installing to extension dir</div>
      <div class="step pending" id="step-config"><span class="step-icon">○</span> Creating archexa.yaml</div>
      <div class="step pending" id="step-ready"><span class="step-icon">○</span> Ready</div>
    </div>

    <div class="terminal-box" id="terminal"></div>
  </div>

  <!-- PHASE 3 — Done -->
  <div id="phase3" class="hidden">
    <div class="done-title">✅ Archexa <span id="done-version">v0.0.0</span> is ready!</div>

    <div class="section-label">Binary location</div>
    <div class="copy-box">
      <span class="copy-text" id="done-path">...</span>
      <button class="copy-btn" id="copyPathBtn">Copy</button>
    </div>
    <div class="hint-text">Managed by the extension. Do not move manually.</div>

    <div class="section-label">VS Code settings written</div>
    <div class="settings-written">
      <div class="settings-row"><span class="sk">archexa.binaryPath</span><span class="sv" id="done-path2">...</span></div>
      <div class="settings-row"><span class="sk">archexa.binaryVersion</span><span class="sv" id="done-ver2">...</span></div>
    </div>

    <div class="section-label">Config file</div>
    <div class="copy-box">
      <span class="copy-text">./archexa.yaml</span>
      <button class="copy-btn" id="copyConfigBtn">Copy</button>
    </div>

    <div class="next-steps">
      <div class="section-label">Next steps</div>
      <div class="next-step"><span class="ns-num">1</span><span class="ns-body">🔑 Set API key → Settings → Connection → API Key</span></div>
      <div class="next-step"><span class="ns-num">2</span><span class="ns-body">🖱️ Right-click any file → Archexa</span></div>
      <div class="next-step"><span class="ns-num">3</span><span class="ns-body">🏛️ Open sidebar → click 🏛️ in activity bar</span></div>
    </div>

    <div class="done-actions">
      <button class="btn-primary" id="getStartedBtn">Get Started →</button>
      <button class="btn-secondary" id="apiKeyBtn">🔑 Set API Key</button>
    </div>
  </div>

  <script nonce="ONBOARD">
    const vscodeApi = acquireVsCodeApi();

    const STEP_MAP = {
      "Detecting platform": "step-platform",
      "Fetching release info": "step-release",
      "Downloading bundle": "step-download",
      "Verifying integrity": "step-verify",
      "Installing to extension dir": "step-install",
      "Creating archexa.yaml": "step-config",
      "Ready": "step-ready",
    };

    const STEP_ORDER = Object.keys(STEP_MAP);

    document.getElementById("downloadBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "startDownload" });
      document.getElementById("phase1").classList.add("hidden");
      document.getElementById("phase2").classList.remove("hidden");
    });

    document.getElementById("getStartedBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "getStarted" });
    });

    document.getElementById("apiKeyBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "openSettings" });
    });

    document.getElementById("copyPathBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(document.getElementById("done-path").textContent || "");
    });

    document.getElementById("copyConfigBtn").addEventListener("click", () => {
      navigator.clipboard.writeText("./archexa.yaml");
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "platform":
          document.getElementById("plat-icon").textContent = msg.icon;
          document.getElementById("plat-label").textContent = msg.label + " · " + "${process.arch}";
          document.getElementById("plat-asset").textContent = msg.asset;
          document.getElementById("plat-size").textContent = msg.size;
          document.getElementById("plat-path").textContent = msg.installPath;
          document.getElementById("dl-asset").textContent = msg.asset + " (" + msg.size + ")";
          break;

        case "progress": {
          const pctEl = document.getElementById("dl-pct");
          const fillEl = document.getElementById("progressFill");
          pctEl.textContent = msg.pct + "%";
          fillEl.style.width = msg.pct + "%";

          // Update steps
          const currentIdx = STEP_ORDER.indexOf(msg.step);
          for (let i = 0; i < STEP_ORDER.length; i++) {
            const stepEl = document.getElementById(STEP_MAP[STEP_ORDER[i]]);
            if (i < currentIdx) {
              stepEl.className = "step done";
              stepEl.querySelector(".step-icon").textContent = "✓";
            } else if (i === currentIdx) {
              stepEl.className = "step active";
              stepEl.querySelector(".step-icon").textContent = "⟳";
            } else {
              stepEl.className = "step pending";
              stepEl.querySelector(".step-icon").textContent = "○";
            }
          }

          // Terminal log
          const terminal = document.getElementById("terminal");
          terminal.textContent += msg.termLine + "\\n";
          terminal.scrollTop = terminal.scrollHeight;
          break;
        }

        case "done":
          // Mark all steps done
          for (const key of STEP_ORDER) {
            const stepEl = document.getElementById(STEP_MAP[key]);
            stepEl.className = "step done";
            stepEl.querySelector(".step-icon").textContent = "✓";
          }
          document.getElementById("progressFill").style.width = "100%";
          document.getElementById("dl-pct").textContent = "100%";

          // Switch to phase 3
          setTimeout(() => {
            document.getElementById("phase2").classList.add("hidden");
            document.getElementById("phase3").classList.remove("hidden");
            document.getElementById("done-version").textContent = msg.version;
            document.getElementById("done-path").textContent = msg.installPath;
            document.getElementById("done-path2").textContent = msg.installPath;
            document.getElementById("done-ver2").textContent = msg.version;
          }, 800);
          break;
      }
    });

  </script>
</body>
</html>`;
  }
}
