import * as vscode from "vscode";
import { getNonce } from "./utils/platform.js";

export interface HistoryEntry {
  id: string;
  cmd: "diagnose" | "review" | "query" | "impact" | "gist" | "analyze";
  title: string;
  timestamp: number;
  markdown: string;
  filePath?: string;
  question?: string;
}

function getMaxHistory(): number {
  return vscode.workspace.getConfiguration("archexa").get<number>("maxHistory") ?? 30;
}

const CMD_ICONS: Record<string, string> = {
  diagnose: "●", review: "◎", query: "◆",
  impact: "◇", gist: "▪", analyze: "▫",
};

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };

    const cssUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "sidebar.css")
    );

    const nonce = getNonce();
    view.webview.html = this.getHtml(cssUri, nonce);
    this.refresh();

    view.webview.onDidReceiveMessage((msg: { type: string; command?: string; entry?: HistoryEntry }) => {
      switch (msg.type) {
        case "runCommand":
          if (msg.command) void vscode.commands.executeCommand(msg.command);
          break;
        case "openResult":
          if (msg.entry) void vscode.commands.executeCommand("archexa.reopenResult", msg.entry);
          break;
        case "clearHistory":
          this.clearHistory();
          break;
        case "cancelRun":
          // Find and execute the current cancel command
          void vscode.commands.executeCommand("archexa.cancelCurrentRun");
          break;
      }
    });

    // Refresh on config change (model name, deep mode, etc.)
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("archexa")) this.refresh();
    });
  }

  showProgress(label: string, pct: number): void {
    this.view?.webview.postMessage({ type: "progress", label, pct });
  }

  hideProgress(): void {
    this.view?.webview.postMessage({ type: "progressDone" });
  }

  addToHistory(entry: HistoryEntry): void {
    const entries = this.ctx.workspaceState.get<HistoryEntry[]>("archexa.history", []);
    entries.unshift(entry);
    void this.ctx.workspaceState.update("archexa.history", entries.slice(0, getMaxHistory()));
    this.refresh();
  }

  clearHistory(): void {
    void this.ctx.workspaceState.update("archexa.history", []);
    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    // Always hide progress on refresh (clears stale state from previous session)
    this.hideProgress();
    const cfg = vscode.workspace.getConfiguration("archexa");
    const model = cfg.get<string>("model") ?? "gpt-4o";
    const deep = cfg.get<boolean>("deepByDefault") !== false;
    const version = cfg.get<string>("binaryVersion") ?? "";
    const apiKey = cfg.get<string>("apiKey") || process.env.OPENAI_API_KEY || "";
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
    const entries = this.ctx.workspaceState.get<HistoryEntry[]>("archexa.history", []);

    this.view.webview.postMessage({
      type: "update",
      model, deep, version, workspace,
      hasKey: !!apiKey,
      history: entries.map((e) => ({
        ...e,
        // Strip Unicode emoji block (U+1F300–U+1FAFF) from legacy history titles
        title: e.title.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").trim(),
        icon: CMD_ICONS[e.cmd] ?? "·",
        relTime: this.relativeTime(e.timestamp),
        group: this.dateGroup(e.timestamp),
      })),
    });
  }

  private relativeTime(ts: number): string {
    const minutesAgo = Math.floor((Date.now() - ts) / 60000);
    if (minutesAgo < 1) return "now";
    if (minutesAgo < 60) return `${minutesAgo}m`;
    const hoursAgo = Math.floor(minutesAgo / 60);
    if (hoursAgo < 24) return `${hoursAgo}h`;
    const daysAgo = Math.floor(hoursAgo / 24);
    return `${daysAgo}d`;
  }

  private dateGroup(ts: number): string {
    const now = new Date();
    const date = new Date(ts);
    const diff = Math.floor((now.getTime() - date.getTime()) / 86400000);
    if (diff === 0 && now.getDate() === date.getDate()) return "Today";
    if (diff <= 1) return "Yesterday";
    return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
  }

  private getHtml(cssUri: vscode.Uri, nonce: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.view!.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.view!.webview.cspSource} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>
  <div class="sidebar-scroll">
  <!-- Status -->
  <div class="status-card">
    <div class="status-row">
      <span class="status-dot" id="statusDot"></span>
      <span class="status-value" id="statusText">Initializing...</span>
    </div>
    <div class="status-row">
      <span class="status-value" id="modelName" style="opacity:0.7">...</span>
    </div>
    <div class="status-row">
      <span id="modeBadge"></span>
      <span style="margin-left:auto" class="status-label" id="versionLabel"></span>
    </div>
  </div>

  <!-- Progress (shown during active run) -->
  <div id="progressSection" class="progress-section" style="display:none">
    <div class="progress-row">
      <span class="progress-spinner">⟳</span>
      <span id="progressLabel">Running...</span>
      <span id="cancelBtn" class="progress-cancel">Cancel</span>
    </div>
    <div class="progress-track">
      <div id="progressFill" class="progress-fill"></div>
    </div>
  </div>

  <div class="section-header" style="display:flex;align-items:center;justify-content:space-between;padding-right:14px">
    <span>Recent Results</span>
    <span id="clearHistoryBtn" class="clear-btn">Clear</span>
  </div>
  <div id="historyContainer">
    <div class="history-empty">No results yet. Run a command to get started.</div>
  </div>

  </div><!-- end sidebar-scroll -->

  <!-- Footer -->
  <div class="sidebar-footer">
    <button class="footer-btn" data-cmd="archexa.openChat">◆ Chat</button>
    <button class="footer-btn" data-cmd="archexa.openSettings">⚙ Settings</button>
    <button class="footer-btn" data-cmd="archexa.checkBinary">↻ Update</button>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    // Command clicks
    document.querySelectorAll("[data-cmd]").forEach(el => {
      el.addEventListener("click", () => {
        vscodeApi.postMessage({ type: "runCommand", command: el.getAttribute("data-cmd") });
      });
    });

    document.getElementById("clearHistoryBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "clearHistory" });
    });

    document.getElementById("cancelBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "cancelRun" });
    });

    // Receive updates
    let historyData = [];
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "progress") {
        const sec = document.getElementById("progressSection");
        sec.style.display = "block";
        document.getElementById("progressLabel").textContent = msg.label;
        document.getElementById("progressFill").style.width = msg.pct + "%";
        return;
      }
      if (msg.type === "progressDone") {
        document.getElementById("progressSection").style.display = "none";
        return;
      }
      if (msg.type !== "update") return;

      // Status
      const dot = document.getElementById("statusDot");
      const statusText = document.getElementById("statusText");
      if (msg.hasKey) {
        dot.className = "status-dot ok";
        statusText.textContent = msg.workspace ? "Ready — " + msg.workspace : "Ready";
      } else {
        dot.className = "status-dot warn";
        statusText.textContent = "No API key configured";
      }
      document.getElementById("modelName").textContent = msg.model;
      document.getElementById("modeBadge").innerHTML = msg.deep
        ? '<span class="cmd-badge deep">DEEP</span>'
        : '<span class="cmd-badge pipeline">PIPELINE</span>';
      document.getElementById("versionLabel").textContent = msg.version ? "v" + msg.version.replace(/^v/, "") : "";

      // History
      historyData = msg.history || [];
      renderHistory();
    });

    function renderHistory() {
      const container = document.getElementById("historyContainer");
      if (historyData.length === 0) {
        container.innerHTML = '<div class="history-empty">No results yet. Run a command to get started.</div>';
        return;
      }

      let html = "";
      let lastGroup = "";
      for (const item of historyData) {
        if (item.group !== lastGroup) {
          html += '<div class="history-group">' + item.group + '</div>';
          lastGroup = item.group;
        }
        const title = (item.title || "").length > 40 ? item.title.slice(0, 40) + "..." : item.title;
        html += '<div class="history-item" data-idx="' + historyData.indexOf(item) + '">'
          + '<span class="history-icon">' + item.icon + '</span>'
          + '<span class="history-title">' + title + '</span>'
          + '<span class="history-time">' + item.relTime + '</span>'
          + '</div>';
      }
      container.innerHTML = html;

      container.querySelectorAll(".history-item").forEach(el => {
        el.addEventListener("click", () => {
          const idx = parseInt(el.getAttribute("data-idx") || "0");
          if (historyData[idx]) {
            vscodeApi.postMessage({ type: "openResult", entry: historyData[idx] });
          }
        });
      });
    }
  </script>
</body>
</html>`;
  }
}
