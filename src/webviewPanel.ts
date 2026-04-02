import * as vscode from "vscode";
import * as path from "path";
import { marked } from "marked";
import { getNonce } from "./utils/platform.js";

type CommandType = "diagnose" | "review" | "query" | "impact" | "gist" | "analyze" | "explain";

/** Known source file extensions for file:line linkification */
const FILE_EXTS = "py|ts|tsx|js|jsx|go|java|rs|rb|cs|kt|cpp|c|h|hpp|php|yaml|yml|json|md|toml|cfg|ini|sh|bash|sql|html|css|scss|xml|proto|graphql|tf|hcl";

/**
 * Post-process rendered HTML to make file:line references clickable.
 * Matches patterns like `src/foo.py:42` or `api/auth.py:7`.
 * Avoids false positives like version strings (node:14), timestamps, or port numbers.
 */
function linkifyFileRefs(html: string): string {
  // Match: optional backtick, path with at least one segment containing a known extension, colon, line number, optional backtick
  const pattern = new RegExp(
    `(?<!\\/\\/)(?:^|(?<=[ \\t(>"'\`]))` +
    `([\\w./@-]+\\.(?:${FILE_EXTS})):(\\d+)` +
    `(?=[ \\t)<"'\`,;]|$)`,
    "gm"
  );
  return html.replace(pattern, (_match, filePath: string, line: string) => {
    const escaped = filePath.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<a class="file-link" data-file="${escaped}" data-line="${line}" title="Open ${escaped}:${line}">${escaped}:${line}</a>`;
  });
}

const COMMAND_LABELS: Record<CommandType, string> = {
  diagnose: "Diagnose",
  review: "Review",
  query: "Query",
  impact: "Impact",
  gist: "Gist",
  analyze: "Analyze",
  explain: "Explain",
};

export class ArchexaWebviewPanel {
  private static panels = new Map<string, ArchexaWebviewPanel>();
  private readonly panel: vscode.WebviewPanel;
  private buffer = "";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private extensionUri: vscode.Uri;
  private commandType: CommandType = "query";
  private findingCounts = { error: 0, warning: 0, info: 0 };

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    panel.onDidDispose(() => {
      for (const [key, val] of ArchexaWebviewPanel.panels) {
        if (val === this) {
          ArchexaWebviewPanel.panels.delete(key);
        }
      }
    });
    // Register message handler once per panel lifetime (not per reset)
    panel.webview.onDidReceiveMessage((msg: { type: string; file?: string; line?: number }) => {
      switch (msg.type) {
        case "save":
          void this.saveToFile();
          break;
        case "openFile":
          if (msg.file) void this.openFileAtLine(msg.file, msg.line ?? 1);
          break;
      }
    });
  }

  static getOrCreate(
    id: string,
    title: string,
    column: vscode.ViewColumn,
    extensionUri?: vscode.Uri
  ): ArchexaWebviewPanel {
    const existing = ArchexaWebviewPanel.panels.get(id);
    if (existing) {
      existing.panel.reveal(column);
      return existing;
    }
    if (!extensionUri) {
      throw new Error("extensionUri required for first panel creation");
    }
    const panel = vscode.window.createWebviewPanel(
      "archexa.result",
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
      }
    );
    const instance = new ArchexaWebviewPanel(panel, extensionUri);
    ArchexaWebviewPanel.panels.set(id, instance);
    return instance;
  }

  /** Reset panel for a new run. Sets HTML to empty first to force a full DOM teardown. */
  reset(title: string, cmdType: CommandType): void {
    this.buffer = "";
    this.commandType = cmdType;
    this.findingCounts = { error: 0, warning: 0, info: 0 };
    this.panel.title = title;

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    this.panel.webview.html = "";
    this.panel.webview.html = this.getHtml(cssUri);

    setTimeout(() => {
      this.panel.webview.postMessage({ type: "resetState" });
    }, 50);
  }

  appendChunk(text: string): void {
    this.buffer += text;
    this.debounceRender();
  }

  private debounceRender(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const html = linkifyFileRefs(marked.parse(this.buffer) as string);
      this.panel.webview.postMessage({ type: "chunk", html });
    }, 80);
  }

  updateProgress(
    phase: number,
    total: number,
    label: string,
    detail?: string
  ): void {
    const pct = total > 0 ? Math.round((phase / total) * 100) : 0;
    this.panel.webview.postMessage({
      type: "progress",
      phase,
      total,
      label,
      detail: detail ?? "",
      pct,
    });
  }

  setMeta(model: string, workspace: string): void {
    this.panel.webview.postMessage({
      type: "meta",
      command: this.commandType,
      model,
      workspace,
    });
  }

  addFindingBadge(severity: "error" | "warning" | "info"): void {
    this.findingCounts[severity]++;
    const parts: string[] = [];
    if (this.findingCounts.error > 0) {
      parts.push(`⬤ ${this.findingCounts.error} error${this.findingCounts.error > 1 ? "s" : ""}`);
    }
    if (this.findingCounts.warning > 0) {
      parts.push(`◆ ${this.findingCounts.warning} warning${this.findingCounts.warning > 1 ? "s" : ""}`);
    }
    if (this.findingCounts.info > 0) {
      parts.push(`● ${this.findingCounts.info} info`);
    }
    this.panel.webview.postMessage({
      type: "finding",
      severity,
      message: parts.join(" · "),
    });
  }

  setDone(
    durationMs?: number,
    promptTokens?: number,
    completionTokens?: number
  ): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.buffer) {
      const html = linkifyFileRefs(marked.parse(this.buffer) as string);
      this.panel.webview.postMessage({ type: "chunk", html });
    }
    this.panel.webview.postMessage({
      type: "done",
      durationMs: durationMs ?? 0,
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
    });
  }

  showError(message: string): void {
    // Send error AFTER done so it overrides the progress bar state
    this.panel.webview.postMessage({ type: "error", message });
  }

  setCancelled(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.panel.webview.postMessage({ type: "cancelled" });
  }

  setContentDirect(markdown: string): void {
    this.buffer = markdown;
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    this.panel.webview.html = this.getHtml(cssUri);

    // Small delay so webview initializes
    setTimeout(() => {
      const html = linkifyFileRefs(marked.parse(markdown) as string);
      this.panel.webview.postMessage({ type: "chunk", html });
      this.panel.webview.postMessage({
        type: "done",
        durationMs: 0,
        promptTokens: 0,
        completionTokens: 0,
      });
    }, 100);
  }

  getBuffer(): string {
    return this.buffer;
  }

  private async openFileAtLine(filePath: string, line: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Resolve: absolute path wins, otherwise join with workspace root
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : workspaceRoot
        ? path.join(workspaceRoot, filePath)
        : filePath;
    try {
      const doc = await vscode.workspace.openTextDocument(resolved);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      vscode.window.showWarningMessage(`Could not open: ${filePath}`);
    }
  }

  private async saveToFile(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("archexa");
    const defaultDir = cfg.get<string>("outputDir") ?? ".archexa";
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const defaultPath = path.join(
      workspaceRoot,
      defaultDir,
      `archexa-${this.commandType}-${Date.now()}.md`
    );

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { Markdown: ["md"] },
    });
    if (uri) {
      const dir = path.dirname(uri.fsPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(this.buffer, "utf8")
      );
      vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
    }
  }

  private getHtml(cssUri: vscode.Uri): string {
    const label = COMMAND_LABELS[this.commandType] ?? "Archexa";
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>
  <div id="meta-bar">
    <span class="meta-item"><strong>${label}</strong></span>
    <span class="meta-item" id="meta-model"></span>
    <span class="meta-item" id="meta-workspace"></span>
    <span class="meta-item" id="meta-duration" class="hidden"></span>
    <span class="meta-item" id="meta-tokens" class="hidden"></span>
  </div>

  <div id="phase-strip">
    <div class="phase-bar"><div class="phase-fill" id="phaseFill"></div></div>
    <div class="phase-labels" id="phaseLabels"></div>
  </div>

  <div id="toolbar">
    <button class="tb-btn" id="copyBtn" disabled>Copy</button>
    <button class="tb-btn" id="saveBtn" disabled>Save</button>
    <span id="findings-badge"></span>
  </div>

  <div id="error-banner"></div>
  <div id="spinner">⟳ Archexa is investigating...</div>
  <div id="content"></div>
  <span id="cursor"></span>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const contentEl = document.getElementById("content");
    const spinnerEl = document.getElementById("spinner");
    const cursorEl = document.getElementById("cursor");
    const copyBtn = document.getElementById("copyBtn");
    const saveBtn = document.getElementById("saveBtn");
    const errorBanner = document.getElementById("error-banner");
    let rawMarkdown = "";
    let userScrolledUp = false;

    contentEl.addEventListener("scroll", () => {
      const el = contentEl;
      userScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 100;
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "resetState":
          // Explicitly clear all state from previous runs
          contentEl.innerHTML = "";
          errorBanner.style.display = "none";
          errorBanner.textContent = "";
          spinnerEl.classList.remove("hidden");
          cursorEl.classList.remove("hidden");
          copyBtn.disabled = true;
          saveBtn.disabled = true;
          document.getElementById("phaseFill").style.width = "0%";
          document.getElementById("phaseLabels").textContent = "";
          document.getElementById("findings-badge").textContent = "";
          break;

        case "meta":
          document.getElementById("meta-model").textContent = msg.model || "";
          document.getElementById("meta-workspace").textContent = msg.workspace || "";
          break;

        case "chunk":
          spinnerEl.classList.add("hidden");
          contentEl.innerHTML = msg.html;
          if (!userScrolledUp) {
            window.scrollTo(0, document.body.scrollHeight);
          }
          break;

        case "progress": {
          const fill = document.getElementById("phaseFill");
          fill.style.width = msg.pct + "%";
          const labels = document.getElementById("phaseLabels");
          labels.textContent = "[" + msg.phase + "/" + msg.total + "] " + msg.label;
          if (msg.detail) labels.textContent += " — " + msg.detail;
          break;
        }

        case "done": {
          cursorEl.classList.add("hidden");
          spinnerEl.classList.add("hidden");
          copyBtn.disabled = false;
          saveBtn.disabled = false;
          // Only fill progress to 100% if there was no error
          if (errorBanner.style.display !== "block") {
            document.getElementById("phaseFill").style.width = "100%";
          }
          if (msg.durationMs > 0) {
            const dur = document.getElementById("meta-duration");
            dur.textContent = (msg.durationMs / 1000).toFixed(1) + "s";
            dur.classList.remove("hidden");
          }
          if (msg.promptTokens > 0 || msg.completionTokens > 0) {
            const tok = document.getElementById("meta-tokens");
            tok.textContent = msg.promptTokens + " / " + msg.completionTokens + " tokens";
            tok.classList.remove("hidden");
          }
          break;
        }

        case "error":
          errorBanner.textContent = msg.message;
          errorBanner.style.display = "block";
          spinnerEl.classList.add("hidden");
          cursorEl.classList.add("hidden");
          document.getElementById("phaseFill").style.width = "0%";
          document.getElementById("phaseLabels").textContent = msg.message;
          break;

        case "cancelled":
          spinnerEl.classList.add("hidden");
          cursorEl.classList.add("hidden");
          copyBtn.disabled = false;
          saveBtn.disabled = false;
          document.getElementById("phaseFill").style.width = "0%";
          document.getElementById("phaseLabels").textContent = "Cancelled";
          // Use muted style, not error red
          errorBanner.textContent = "Cancelled by user";
          errorBanner.style.display = "block";
          errorBanner.style.background = "var(--vscode-editor-lineHighlightBackground)";
          errorBanner.style.borderColor = "var(--vscode-editorGroup-border)";
          errorBanner.style.color = "var(--vscode-descriptionForeground)";
          break;

        case "finding":
          document.getElementById("findings-badge").textContent = msg.message;
          break;
      }
    });

    copyBtn.addEventListener("click", () => {
      const text = contentEl.innerText || contentEl.textContent || "";
      navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });

    saveBtn.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "save" });
    });

    // Clickable file:line references
    document.addEventListener("click", (e) => {
      const link = e.target.closest(".file-link");
      if (link) {
        e.preventDefault();
        vscodeApi.postMessage({
          type: "openFile",
          file: link.dataset.file,
          line: parseInt(link.dataset.line, 10) || 1,
        });
      }
    });
  </script>
</body>
</html>`;
  }
}
