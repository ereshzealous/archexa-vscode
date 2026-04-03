import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { marked } from "marked";
import { ArchexaBridge, ReviewFinding } from "./bridge.js";
import { DiagnosticsManager } from "./diagnosticsManager.js";
import { StatusBarItem } from "./statusBarItem.js";
import { SidebarProvider } from "./sidebarProvider.js";
import { Logger } from "./utils/logger.js";
import { getNonce } from "./utils/platform.js";

export interface ChatServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

interface ParsedCommand {
  command: string;   // internal key: review, diagnose, explain, query, impact, gist, analyze
  cliCommand: string;
  args: string[];
  label: string;
  icon: string;
}

const FILE_EXTS = "py|ts|tsx|js|jsx|go|java|rs|rb|cs|kt|cpp|c|h|hpp|php|yaml|yml|json|md|toml|cfg|ini|sh|bash|sql|html|css|scss|xml|proto|graphql|tf|hcl";

function linkifyFileRefs(html: string): string {
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

/**
 * Detect user intent from natural language input.
 * Returns a command key or null if ambiguous (falls back to query).
 */
function detectIntent(text: string): string | null {
  const s = text.toLowerCase();
  if (/\berror\b|exception|failing|crash|why is|traceback|not work|decode|typeerror|stacktrace/.test(s)) return "diagnose";
  if (/\breview\b|check|securi|bug|vulnerab|\bsql\b|jwt|audit|issues?\b/.test(s)) return "review";
  if (/\bexplain\b|what (does|is)|how does|understand|purpose|walk me/.test(s)) return "explain";
  if (/\bimpact\b|what breaks|what happens if|change|affect|downstream/.test(s)) return "impact";
  return null;
}

export class ChatWebview {
  private panel: vscode.WebviewPanel | undefined;
  private tokenSource: vscode.CancellationTokenSource | undefined;
  private streamBuffer = "";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private responseBuffers = new Map<string, string>();
  private logLines = new Map<string, string[]>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly services: ChatServices
  ) {}

  show(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel(
      "archexa.chat", "Archexa Chat", vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")] }
    );
    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.css")
    );
    const nonce = getNonce();
    this.panel.webview.html = this.getHtml(cssUri, nonce);
    this.panel.onDidDispose(() => { this.panel = undefined; this.cancelCurrentRun(); });
    this.panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => this.handleMessage(msg)
    );
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "send":
        if (typeof msg.text === "string" && msg.text.trim()) void this.handleUserMessage(msg.text.trim());
        break;
      case "cancel":
        this.cancelCurrentRun();
        break;
      case "openFile":
        if (typeof msg.file === "string") void this.openFileAtLine(msg.file, (msg.line as number) ?? 1);
        break;
      case "copyMarkdown":
        if (typeof msg.msgId === "string") {
          const buf = this.responseBuffers.get(msg.msgId);
          if (buf) {
            void vscode.env.clipboard.writeText(buf);
            this.panel?.webview.postMessage({ type: "copyConfirm", msgId: msg.msgId });
          }
        }
        break;
      case "saveMarkdown":
        if (typeof msg.msgId === "string") void this.saveMarkdown(msg.msgId as string);
        break;
      case "getContext":
        this.sendEditorContext();
        break;
    }
  }

  private sendEditorContext(): void {
    const editor = vscode.window.activeTextEditor;
    const file = editor?.document.uri.scheme === "file"
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : undefined;
    const selection = editor?.selection;
    const hasSelection = selection && !selection.isEmpty;
    const selText = hasSelection ? editor!.document.getText(selection).split("\n")[0].slice(0, 40) : undefined;
    this.panel?.webview.postMessage({
      type: "editorContext",
      file: file ? path.basename(file) : undefined,
      filePath: file,
      selection: selText,
    });
  }

  private cancelCurrentRun(): void {
    if (this.tokenSource) { this.tokenSource.cancel(); this.tokenSource.dispose(); this.tokenSource = undefined; }
  }

  private async handleUserMessage(text: string): Promise<void> {
    const parsed = this.parseCommand(text);
    const msgId = Date.now().toString();

    this.panel?.webview.postMessage({ type: "userMessage", text });
    this.panel?.webview.postMessage({
      type: "assistantStart", id: msgId,
      label: parsed.label, command: parsed.command,
    });

    this.tokenSource = new vscode.CancellationTokenSource();
    this.services.statusBar.setRunning(parsed.label, this.tokenSource);
    this.streamBuffer = "";
    this.logLines.set(msgId, []);

    try {
      const result = await this.services.bridge.run({
        command: parsed.cliCommand,
        args: parsed.args,
        onChunk: (chunk) => {
          this.streamBuffer += chunk;
          this.debounceStreamRender(msgId);
        },
        onProgress: (phase, total, label, detail) => {
          this.panel?.webview.postMessage({ type: "progress", id: msgId, phase, total, label, detail });
        },
        onFinding: parsed.cliCommand === "review" ? (f: ReviewFinding) => {
          const cfg = vscode.workspace.getConfiguration("archexa");
          if (cfg.get<boolean>("showInlineFindings")) this.services.diagnostics.addFinding(f);
          this.panel?.webview.postMessage({ type: "finding", id: msgId, finding: f });
        } : undefined,
        onLog: (line) => {
          this.logLines.get(msgId)?.push(line);
          this.panel?.webview.postMessage({ type: "agentLog", id: msgId, line });
        },
        onDone: (durationMs, promptTokens, completionTokens) => {
          this.panel?.webview.postMessage({ type: "assistantDone", id: msgId, durationMs, promptTokens, completionTokens });
        },
        token: this.tokenSource.token,
      });

      // Final render
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      const html = linkifyFileRefs(marked.parse(this.streamBuffer) as string);
      this.panel?.webview.postMessage({ type: "assistantChunk", id: msgId, html });
      this.responseBuffers.set(msgId, this.streamBuffer);

      this.panel?.webview.postMessage({ type: "assistantDone", id: msgId, durationMs: result.durationMs });
      this.services.statusBar.setDone(`${parsed.label} complete`);

      // History
      const validCmds = ["diagnose", "review", "query", "impact", "gist", "analyze"] as const;
      const cmd = validCmds.includes(parsed.cliCommand as typeof validCmds[number])
        ? parsed.cliCommand as typeof validCmds[number] : "query" as const;
      this.services.sidebar.addToHistory({
        id: crypto.randomUUID(), cmd,
        title: `${parsed.label} — ${text.slice(0, 48)}`,
        timestamp: Date.now(), markdown: this.streamBuffer,
      });
    } catch (err: unknown) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.tokenSource?.token.isCancellationRequested) {
        this.panel?.webview.postMessage({ type: "assistantCancelled", id: msgId });
        this.services.statusBar.setIdle();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.panel?.webview.postMessage({ type: "assistantError", id: msgId, message });
        this.services.statusBar.setError(message);
        this.services.logger.error(`Chat failed: ${message}`);
      }
    } finally {
      this.tokenSource?.dispose();
      this.tokenSource = undefined;
    }
  }

  private debounceStreamRender(msgId: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const html = linkifyFileRefs(marked.parse(this.streamBuffer) as string);
      this.panel?.webview.postMessage({ type: "assistantChunk", id: msgId, html });
    }, 80);
  }

  private parseCommand(text: string): ParsedCommand {
    // /review
    if (text.startsWith("/review")) {
      const rest = text.slice(7).trim();
      if (rest === "--changed" || rest === "changes" || rest === "changed") {
        return { command: "review", cliCommand: "review", args: ["--changed"], label: "Review Changes", icon: "search" };
      }
      if (rest.startsWith("--")) return { command: "review", cliCommand: "review", args: rest.split(/\s+/), label: "Review", icon: "search" };
      if (rest) return { command: "review", cliCommand: "review", args: ["--target", rest], label: `Review ${path.basename(rest)}`, icon: "search" };
      const f = this.getCurrentFileRelPath();
      return f
        ? { command: "review", cliCommand: "review", args: ["--target", f], label: `Review ${path.basename(f)}`, icon: "search" }
        : { command: "review", cliCommand: "review", args: [], label: "Review", icon: "search" };
    }
    // /impact
    if (text.startsWith("/impact")) {
      const rest = text.slice(7).trim();
      if (rest.startsWith("--")) return { command: "impact", cliCommand: "impact", args: rest.split(/\s+/), label: "Impact", icon: "zap" };
      const parts = rest.split(/\s+/);
      const target = parts[0] || this.getCurrentFileRelPath() || "";
      const query = parts.slice(1).join(" ");
      const args = target ? ["--target", target] : [];
      if (query) args.push("--query", query);
      return { command: "impact", cliCommand: "impact", args, label: `Impact ${target ? path.basename(target) : ""}`, icon: "zap" };
    }
    // /diagnose
    if (text.startsWith("/diagnose")) {
      const rest = text.slice(9).trim();
      return rest
        ? { command: "diagnose", cliCommand: "diagnose", args: ["--error", rest.slice(0, 3000)], label: "Diagnose", icon: "bug" }
        : { command: "diagnose", cliCommand: "diagnose", args: [], label: "Diagnose", icon: "bug" };
    }
    // /gist
    if (text.startsWith("/gist")) return { command: "gist", cliCommand: "gist", args: [], label: "Gist", icon: "book" };
    // /analyze
    if (text.startsWith("/analyze")) return { command: "analyze", cliCommand: "analyze", args: [], label: "Analyze", icon: "graph" };
    // /query
    if (text.startsWith("/query")) {
      const rest = text.slice(6).trim();
      return { command: "query", cliCommand: "query", args: ["--query", rest || text], label: "Query", icon: "comment" };
    }

    // Natural language — detect intent
    const intent = detectIntent(text);
    if (intent === "diagnose") {
      return { command: "diagnose", cliCommand: "diagnose", args: ["--error", text.slice(0, 3000)], label: "Diagnose", icon: "bug" };
    }
    if (intent === "review") {
      const f = this.getCurrentFileRelPath();
      return f
        ? { command: "review", cliCommand: "review", args: ["--target", f], label: `Review ${path.basename(f)}`, icon: "search" }
        : { command: "query", cliCommand: "query", args: ["--query", text], label: "Query", icon: "comment" };
    }
    if (intent === "impact") {
      const f = this.getCurrentFileRelPath();
      const args = f ? ["--target", f, "--query", text] : ["--query", text];
      return { command: f ? "impact" : "query", cliCommand: f ? "impact" : "query", args, label: f ? `Impact ${path.basename(f)}` : "Query", icon: f ? "zap" : "comment" };
    }

    // Default: query
    return { command: "query", cliCommand: "query", args: ["--query", text], label: "Query", icon: "comment" };
  }

  private getCurrentFileRelPath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return undefined;
    return vscode.workspace.asRelativePath(editor.document.uri);
  }

  private async saveMarkdown(msgId: string): Promise<void> {
    const content = this.responseBuffers.get(msgId);
    if (!content) return;
    const cfg = vscode.workspace.getConfiguration("archexa");
    const outputDir = cfg.get<string>("outputDir") ?? ".archexa";
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const defaultPath = path.join(workspaceRoot, outputDir, `archexa-chat-${Date.now()}.md`);
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters: { Markdown: ["md"] } });
    if (uri) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
    }
  }

  private async openFileAtLine(filePath: string, line: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolved = path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.join(workspaceRoot, filePath) : filePath;
    try {
      const doc = await vscode.workspace.openTextDocument(resolved);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch { vscode.window.showWarningMessage(`Could not open: ${filePath}`); }
  }

  private getHtml(cssUri: vscode.Uri, nonce: string): string {
    const csp = this.panel!.webview.cspSource;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${csp} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>
  <div class="chat-messages" id="messages">
    <div id="homeScreen">
      <div class="home-hero">
        <span class="home-hero-icon">\uD83C\uDFDB\uFE0F</span>
        <h2>Understand your code</h2>
        <p>Independent investigations.<br/>No memory. Just accurate answers.</p>
      </div>
      <div class="cmd-cards" id="cmdCards"></div>
    </div>
  </div>

  <div class="chat-input-area">
    <div class="context-strip" id="contextStrip"></div>
    <div id="intentBadge" style="display:none"></div>
    <div id="slashMenu" style="display:none" class="slash-menu"></div>
    <div class="input-row">
      <textarea id="chatInput" rows="1" placeholder='Ask anything... (e.g. "why is login failing?")'></textarea>
      <button id="sendBtn">Send</button>
      <button id="cancelBtn">Cancel</button>
    </div>
    <div class="input-hints">
      <span><kbd>Enter</kbd> send <kbd>Shift+Enter</kbd> new line <kbd>/</kbd> commands</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const homeScreen = document.getElementById("homeScreen");
    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("sendBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const slashMenu = document.getElementById("slashMenu");
    const intentBadge = document.getElementById("intentBadge");
    const contextStrip = document.getElementById("contextStrip");
    let isStreaming = false;
    let slashIdx = -1;
    let currentIntent = null;

    // Command definitions for home cards and slash menu
    // SVG icons for each command (16x16, currentColor)
    const ICONS = {
      explain:  '\\u{1F4A1}',
      review:   '\\u{1F50D}',
      diagnose: '\\u{1F534}',
      impact:   '\\u26A1',
      query:    '\\u{1F4AC}',
      gist:     '\\u{1F4C4}',
      analyze:  '\\u{1F4CA}',
    };

    const CMDS = [
      { id:"explain",  type:"explain",  slash:"/explain",           args:"<fn>",       desc:"Understand any function, file, or pattern",   what:"Plain-English \u00B7 risks \u00B7 dependencies" },
      { id:"review",   type:"review",   slash:"/review",            args:"<file>",     desc:"Find bugs, security issues, risky patterns",  what:"Findings first \u00B7 then explanation \u00B7 editor squiggles" },
      { id:"review2",  type:"review",   slash:"/review --changed",  args:"",           desc:"Review uncommitted changes",                  what:"Review your git changes" },
      { id:"diagnose", type:"diagnose", slash:"/diagnose",          args:"<error>",    desc:"Trace any error to its root cause",           what:"Call chain first \u00B7 root cause \u00B7 fix" },
      { id:"impact",   type:"impact",   slash:"/impact",            args:"<file>",     desc:"What breaks if this changes?",                what:"Trace callers and consumers" },
      { id:"query",    type:"query",    slash:"/query",             args:"<question>", desc:"Ask anything about your codebase",             what:"Deep investigation with citations" },
      { id:"gist",     type:"gist",     slash:"/gist",              args:"",           desc:"Quick codebase overview",                     what:"Fast overview of everything" },
      { id:"analyze",  type:"analyze",  slash:"/analyze",           args:"",           desc:"Full architecture documentation",             what:"Comprehensive architecture doc" },
    ];

    // Intent detection (mirrors server-side)
    function detectIntent(t) {
      const s = t.toLowerCase();
      if (/\\berror\\b|exception|failing|crash|why is|traceback|not work|decode|typeerror/.test(s)) return { id:"diagnose", label:"Diagnose", icon:"\\u{1F534}" };
      if (/\\breview\\b|check|securi|bug|vulnerab|\\bsql\\b|jwt|audit|issues?/.test(s)) return { id:"review", label:"Review", icon:"\\u{1F50D}" };
      if (/explain|what (does|is)|how does|understand|purpose/.test(s)) return { id:"explain", label:"Explain", icon:"\\u{1F4A1}" };
      if (/impact|what breaks|what happens if|change|affect/.test(s)) return { id:"impact", label:"Impact", icon:"\\u26A1" };
      return null;
    }

    // Build home cards
    const cardsHtml = CMDS.filter(c => !c.id.includes("2")).map(c =>
      '<div class="cmd-card" data-slash="' + c.slash + '" data-type="' + c.type + '">'
      + '<div class="cmd-card-icon">' + (ICONS[c.type] || "") + '</div>'
      + '<div class="cmd-card-body">'
      + '<div class="cmd-card-title"><span>' + c.slash.replace("/","").charAt(0).toUpperCase() + c.slash.replace("/","").slice(1) + '</span>'
      + '<span class="cmd-card-tagline">' + c.desc + '</span></div>'
      + '<div class="cmd-card-what">' + (c.what || "") + '</div>'
      + '</div><span class="cmd-card-arrow">\\u25B6</span></div>'
    ).join("");
    document.getElementById("cmdCards").innerHTML = cardsHtml;
    document.querySelectorAll(".cmd-card").forEach(el => {
      el.addEventListener("click", () => {
        const slash = el.dataset.slash;
        chatInput.value = slash + " ";
        chatInput.focus();
        updateSlashMenu();
      });
    });

    // Request editor context on load and periodically
    vscodeApi.postMessage({ type: "getContext" });

    // Auto-resize textarea
    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
      updateSlashMenu();
      updateIntent();
    });

    function updateSlashMenu() {
      const val = chatInput.value;
      if (!val.startsWith("/") || val.includes(" ") || isStreaming) { slashMenu.style.display = "none"; return; }
      const filter = val.toLowerCase();
      const matches = CMDS.filter(c => c.slash.startsWith(filter));
      if (!matches.length) { slashMenu.style.display = "none"; return; }
      slashMenu.innerHTML = matches.map((c, i) =>
        '<div class="slash-item' + (i === 0 ? ' active' : '') + '" data-cmd="' + c.slash + '">'
        + '<span class="slash-icon">' + (ICONS[c.type] || "") + '</span>'
        + '<span class="slash-cmd">' + c.slash + '</span>'
        + (c.args ? ' <span class="slash-args">' + c.args + '</span>' : '')
        + '<span class="slash-desc">' + c.desc + '</span></div>'
      ).join("");
      slashIdx = 0;
      slashMenu.style.display = "block";
      slashMenu.querySelectorAll(".slash-item").forEach(el => {
        el.addEventListener("click", () => selectSlash(el));
      });
    }

    function updateIntent() {
      const val = chatInput.value.trim();
      if (!val || val.startsWith("/") || isStreaming) { intentBadge.style.display = "none"; currentIntent = null; return; }
      const det = detectIntent(val);
      if (det) {
        currentIntent = det;
        intentBadge.innerHTML = '<span>' + det.icon + '</span><span style="font-weight:600">' + det.label + '</span><span style="color:var(--vscode-descriptionForeground)">detected</span><span class="intent-badge-hint">Tab \\u21B5</span>';
        intentBadge.style.display = "flex";
        intentBadge.className = "intent-badge";
        intentBadge.style.background = "rgba(56,139,253,0.07)";
        intentBadge.style.border = "1px solid rgba(56,139,253,0.2)";
      } else {
        intentBadge.style.display = "none";
        currentIntent = null;
      }
    }

    function selectSlash(el) {
      chatInput.value = el.dataset.cmd + " ";
      chatInput.focus();
      slashMenu.style.display = "none";
    }

    function highlightSlash(items) {
      items.forEach((el, i) => el.classList.toggle("active", i === slashIdx));
    }

    // Keyboard
    chatInput.addEventListener("keydown", (e) => {
      if (slashMenu.style.display !== "none") {
        const items = slashMenu.querySelectorAll(".slash-item");
        if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = Math.min(slashIdx + 1, items.length - 1); highlightSlash(items); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = Math.max(slashIdx - 1, 0); highlightSlash(items); return; }
        if ((e.key === "Enter" || e.key === "Tab") && items[slashIdx]) { e.preventDefault(); selectSlash(items[slashIdx]); return; }
        if (e.key === "Escape") { slashMenu.style.display = "none"; return; }
      }
      if (e.key === "Tab" && currentIntent) { e.preventDefault(); sendMessage(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isStreaming && chatInput.value.trim()) sendMessage(); }
    });

    sendBtn.addEventListener("click", () => { if (!isStreaming && chatInput.value.trim()) sendMessage(); });
    cancelBtn.addEventListener("click", () => { vscodeApi.postMessage({ type: "cancel" }); });

    // Delegated clicks
    document.addEventListener("click", (e) => {
      const link = e.target.closest(".file-link, .finding-file, .dep-file");
      if (link) {
        e.preventDefault();
        vscodeApi.postMessage({ type: "openFile", file: link.dataset.file, line: parseInt(link.dataset.line || "1", 10) });
        return;
      }
      const copyBtn = e.target.closest(".msg-copy-btn");
      if (copyBtn) { vscodeApi.postMessage({ type: "copyMarkdown", msgId: copyBtn.dataset.msgid }); return; }
      const saveBtn = e.target.closest(".msg-save-btn");
      if (saveBtn) { vscodeApi.postMessage({ type: "saveMarkdown", msgId: saveBtn.dataset.msgid }); return; }
      const detailsBtn = e.target.closest(".details-toggle");
      if (detailsBtn) {
        const details = detailsBtn.parentElement.nextElementSibling;
        if (details && details.classList.contains("inv-details")) {
          details.style.display = details.style.display === "none" ? "block" : "none";
          detailsBtn.querySelector("span").textContent = details.style.display === "none" ? "\\u25B8" : "\\u25BE";
        }
        return;
      }
    });

    function sendMessage() {
      vscodeApi.postMessage({ type: "send", text: chatInput.value.trim() });
      chatInput.value = "";
      chatInput.style.height = "auto";
      slashMenu.style.display = "none";
      intentBadge.style.display = "none";
    }

    function setStreaming(on) {
      isStreaming = on;
      sendBtn.style.display = on ? "none" : "block";
      cancelBtn.style.display = on ? "block" : "none";
      sendBtn.disabled = on;
      chatInput.disabled = on;
      if (!on) chatInput.focus();
    }

    function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

    function removeHome() { if (homeScreen) homeScreen.style.display = "none"; }

    // Parse agent log line into rich HTML
    function parseLogLine(line) {
      if (line.includes("agent.tool name=")) {
        const m = line.match(/name=(\\S+)\\s+args=(.*)/);
        if (m) return '<span style="color:var(--vscode-textLink-foreground)">\\u25B8</span> <span style="color:var(--vscode-textLink-foreground);font-weight:600">' + m[1] + '</span> <span style="color:var(--vscode-descriptionForeground);font-size:9.5px">' + m[2].replace(/</g,"&lt;").slice(0,60) + '</span>';
      }
      if (line.includes("agent.investigate iteration=")) {
        const m = line.match(/iteration=(\\d+)/);
        return '<span style="color:var(--vscode-descriptionForeground)">\\u25CB</span> <span>Iteration ' + (m?m[1]:"") + '</span>';
      }
      if (line.includes("agent.investigate done")) {
        const m = line.match(/iterations=(\\d+)\\s+tool_calls=(\\d+)/);
        return '<span style="color:var(--vscode-terminal-ansiGreen)">\\u2713</span> <span style="color:var(--vscode-terminal-ansiGreen)">Done' + (m?" \\u2014 "+m[1]+" iter, "+m[2]+" calls":"") + '</span>';
      }
      if (line.includes("agent.scaling")) {
        const m = line.match(/files=(\\d+).*max_iter=(\\d+)/);
        return '<span style="color:var(--vscode-descriptionForeground)">\\u2699</span> <span>' + (m?m[1]+" files, max "+m[2]+" iter":line) + '</span>';
      }
      if (line.includes("progressive_prune")) {
        const m = line.match(/(\\d+) -> (\\d+) tokens \\(-(\\d+)\\)/);
        return '<span style="color:var(--vscode-editorWarning-foreground)">\\u2702</span> <span style="color:var(--vscode-editorWarning-foreground)">Pruned ' + (m?m[3]:"") + ' tokens</span>';
      }
      if (line.includes("agent.synthesize")) return '<span>\\u270E</span> Generating response...';
      if (line.includes("synthesis.dedup")) return '<span>\\u2261</span> ' + line.replace(/^.*INFO\\s+/,"");
      return null; // skip unrecognized
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "editorContext": {
          let html = "";
          if (msg.file) html += '<span style="color:var(--vscode-disabledForeground)">\\u{1F4C4}</span> <span style="color:var(--vscode-textLink-foreground);font-family:var(--vscode-editor-font-family)">' + msg.file + '</span>';
          if (msg.selection) html += '<span class="context-sep">\\u00B7</span><span style="color:var(--vscode-editorWarning-foreground);font-family:var(--vscode-editor-font-family)">' + msg.selection + '</span>';
          contextStrip.innerHTML = html || '<span style="color:var(--vscode-disabledForeground)">No file open</span>';
          break;
        }

        case "userMessage": {
          removeHome();
          const div = document.createElement("div");
          div.className = "msg-user";
          div.innerHTML = '<div class="msg-bubble">' + msg.text.replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</div>';
          messagesEl.appendChild(div);
          scrollToBottom();
          break;
        }

        case "assistantStart": {
          setStreaming(true);
          const div = document.createElement("div");
          div.className = "msg-assistant msg-streaming";
          div.id = "msg-" + msg.id;
          div.dataset.command = msg.command || "query";
          div.innerHTML =
            '<div class="msg-meta">'
            + '<span class="msg-meta-badge" style="background:rgba(56,139,253,0.12);color:var(--vscode-textLink-foreground)">' + (msg.label || "Query") + '</span>'
            + '<span class="msg-meta-status" style="animation:pulse 1.2s ease-in-out infinite;color:var(--vscode-textLink-foreground)">\\u25CF investigating</span>'
            + '</div>'
            + '<div class="live-step" id="livestep-' + msg.id + '" style="display:none"></div>'
            + '<div id="findings-' + msg.id + '"></div>'
            + '<div id="skeleton-' + msg.id + '" class="skeleton">'
            + '<div class="skeleton-line" style="width:85%"></div>'
            + '<div class="skeleton-line" style="width:65%;animation-delay:0.1s"></div>'
            + '<div class="skeleton-line" style="width:90%;animation-delay:0.2s"></div>'
            + '<div style="height:8px"></div>'
            + '<div class="skeleton-line" style="width:75%;animation-delay:0.3s"></div>'
            + '<div class="skeleton-line" style="width:50%;animation-delay:0.4s"></div>'
            + '</div>'
            + '<div class="msg-content" id="content-' + msg.id + '" style="display:none"></div>'
            + '<div class="msg-toolbar" id="toolbar-' + msg.id + '" style="display:none">'
            + '<button class="tb-sm msg-copy-btn" data-msgid="' + msg.id + '">Copy</button>'
            + '<button class="tb-sm msg-save-btn" data-msgid="' + msg.id + '">Save</button>'
            + '<button class="details-toggle"><span>\\u25B8</span> Investigation details</button>'
            + '</div>'
            + '<div class="inv-details" id="details-' + msg.id + '" style="display:none">'
            + '<div class="inv-details-label">Agent steps</div>'
            + '<div id="loglines-' + msg.id + '"></div>'
            + '</div>';
          messagesEl.appendChild(div);
          scrollToBottom();
          break;
        }

        case "agentLog": {
          const rich = parseLogLine(msg.line || "");
          if (!rich) break;
          // Update live step
          const liveEl = document.getElementById("livestep-" + msg.id);
          if (liveEl && msg.line.includes("agent.tool name=")) {
            liveEl.style.display = "flex";
            const m = msg.line.match(/name=(\\S+)\\s+args=\\{['\"]?(\\w+)['\"]?:\\s*['\"]?([^'"}]+)/);
            liveEl.innerHTML = '<span class="live-step-arrow">\\u2192</span><span class="live-step-text">' + (m ? m[1] + "(" + m[3].slice(0,40) + ")" : "working...") + '</span><div class="dot-pulse"><span></span><span></span><span></span></div>';
          }
          // Append to details log
          const logEl = document.getElementById("loglines-" + msg.id);
          if (logEl) {
            const step = document.createElement("div");
            step.className = "inv-step";
            step.innerHTML = rich;
            logEl.appendChild(step);
          }
          scrollToBottom();
          break;
        }

        case "finding": {
          const f = msg.finding;
          const container = document.getElementById("findings-" + msg.id);
          if (!container) break;
          // Create findings panel if first finding
          if (!container.querySelector(".findings-panel")) {
            container.innerHTML = '<div class="findings-panel"><div class="findings-header"><span>Findings</span><span id="fcounts-' + msg.id + '"></span></div><div id="frows-' + msg.id + '"></div></div>';
          }
          const rows = document.getElementById("frows-" + msg.id);
          const isErr = f.severity === "error" || f.severity === "high" || f.severity === "critical";
          rows.innerHTML += '<div class="finding-row"><span class="finding-sev" style="color:' + (isErr?"var(--vscode-errorForeground)":"var(--vscode-editorWarning-foreground)") + '">' + (isErr?"\\u2B24":"\\u25C6") + '</span><div style="flex:1"><div class="finding-msg">' + (f.message||"").replace(/</g,"&lt;") + '</div><div class="finding-loc"><span class="finding-file file-link" data-file="' + f.file + '" data-line="' + f.line + '">' + f.file + ':' + f.line + '</span>' + (f.rule?'<span class="finding-rule">'+f.rule+'</span>':'') + '</div></div></div>';
          scrollToBottom();
          break;
        }

        case "progress": {
          const el = document.getElementById("msg-" + msg.id);
          if (!el) break;
          const status = el.querySelector(".msg-meta-status");
          if (status) status.textContent = "[" + msg.phase + "/" + msg.total + "] " + msg.label + (msg.detail ? " \\u2014 " + msg.detail : "");
          break;
        }

        case "assistantChunk": {
          const skel = document.getElementById("skeleton-" + msg.id);
          if (skel) skel.style.display = "none";
          const content = document.getElementById("content-" + msg.id);
          if (content) { content.style.display = "block"; content.innerHTML = msg.html; }
          // Hide live step once content starts
          const live = document.getElementById("livestep-" + msg.id);
          if (live) live.style.display = "none";
          scrollToBottom();
          break;
        }

        case "assistantDone": {
          const el = document.getElementById("msg-" + msg.id);
          if (!el) break;
          el.classList.remove("msg-streaming");
          const skel = document.getElementById("skeleton-" + msg.id);
          if (skel) skel.style.display = "none";
          const content = document.getElementById("content-" + msg.id);
          if (content) content.style.display = "block";
          const live = document.getElementById("livestep-" + msg.id);
          if (live) live.style.display = "none";
          // Update meta
          const status = el.querySelector(".msg-meta-status");
          if (status) {
            status.style.animation = "none";
            status.style.color = "var(--vscode-terminal-ansiGreen)";
            status.textContent = "\\u2713 Done" + (msg.durationMs > 0 ? " \\u00B7 " + (msg.durationMs/1000).toFixed(1) + "s" : "");
          }
          // Show toolbar
          const toolbar = document.getElementById("toolbar-" + msg.id);
          if (toolbar) toolbar.style.display = "flex";
          setStreaming(false);
          scrollToBottom();
          break;
        }

        case "assistantError": {
          const el = document.getElementById("msg-" + msg.id);
          if (!el) break;
          el.classList.remove("msg-streaming");
          el.classList.add("msg-error");
          const skel = document.getElementById("skeleton-" + msg.id);
          if (skel) skel.style.display = "none";
          const live = document.getElementById("livestep-" + msg.id);
          if (live) live.style.display = "none";
          const content = document.getElementById("content-" + msg.id);
          if (content) { content.style.display = "block"; content.textContent = msg.message; }
          const status = el.querySelector(".msg-meta-status");
          if (status) { status.style.animation = "none"; status.style.color = "var(--vscode-errorForeground)"; status.textContent = "\\u2717 Error"; }
          setStreaming(false);
          scrollToBottom();
          break;
        }

        case "assistantCancelled": {
          const el = document.getElementById("msg-" + msg.id);
          if (!el) break;
          el.classList.remove("msg-streaming");
          const skel = document.getElementById("skeleton-" + msg.id);
          if (skel) skel.style.display = "none";
          const live = document.getElementById("livestep-" + msg.id);
          if (live) live.style.display = "none";
          const status = el.querySelector(".msg-meta-status");
          if (status) { status.style.animation = "none"; status.style.color = "var(--vscode-descriptionForeground)"; status.textContent = "Cancelled"; }
          setStreaming(false);
          break;
        }

        case "copyConfirm": {
          const el = document.getElementById("msg-" + msg.msgId);
          if (el) { const btn = el.querySelector(".msg-copy-btn"); if (btn) { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy", 1500); } }
          break;
        }
      }
    });

    chatInput.focus();
  </script>
</body>
</html>`;
  }
}
