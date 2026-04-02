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

interface SlashCommand {
  command: string;
  cliCommand: string;
  args: string[];
  label: string;
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

export class ChatWebview {
  private panel: vscode.WebviewPanel | undefined;
  private tokenSource: vscode.CancellationTokenSource | undefined;
  private streamBuffer = "";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private responseBuffers = new Map<string, string>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly services: ChatServices
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "archexa.chat",
      "Archexa Chat",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
      }
    );

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.css")
    );
    const nonce = getNonce();
    this.panel.webview.html = this.getHtml(cssUri, nonce);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.cancelCurrentRun();
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; text?: string; file?: string; line?: number; msgId?: string }) => {
        switch (msg.type) {
          case "send":
            if (msg.text?.trim()) void this.handleUserMessage(msg.text.trim());
            break;
          case "cancel":
            this.cancelCurrentRun();
            break;
          case "openFile":
            if (msg.file) void this.openFileAtLine(msg.file, msg.line ?? 1);
            break;
          case "copyMarkdown":
            if (msg.msgId && this.responseBuffers.get(msg.msgId)) {
              void vscode.env.clipboard.writeText(this.responseBuffers.get(msg.msgId)!);
              this.panel?.webview.postMessage({ type: "copyConfirm", msgId: msg.msgId });
            }
            break;
          case "saveMarkdown":
            if (msg.msgId) void this.saveMarkdown(msg.msgId);
            break;
        }
      }
    );
  }

  private cancelCurrentRun(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel();
      this.tokenSource.dispose();
      this.tokenSource = undefined;
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    // Parse slash commands
    const parsed = this.parseSlashCommand(text);

    // Show user message in chat
    this.panel?.webview.postMessage({ type: "userMessage", text });

    // Start streaming response
    this.tokenSource = new vscode.CancellationTokenSource();
    const msgId = Date.now().toString();

    this.panel?.webview.postMessage({
      type: "assistantStart",
      id: msgId,
      label: parsed.label,
    });

    this.services.statusBar.setRunning(parsed.label, this.tokenSource);
    this.streamBuffer = "";

    try {
      const result = await this.services.bridge.run({
        command: parsed.cliCommand,
        args: parsed.args,
        onChunk: (chunk) => {
          this.streamBuffer += chunk;
          this.debounceStreamRender(msgId);
        },
        onProgress: (phase, total, label, detail) => {
          this.panel?.webview.postMessage({
            type: "progress",
            id: msgId,
            phase, total, label, detail,
          });
        },
        onLog: (line) => {
          this.panel?.webview.postMessage({ type: "agentLog", id: msgId, line });
        },
        onFinding: parsed.cliCommand === "review" ? (f: ReviewFinding) => {
          const cfg = vscode.workspace.getConfiguration("archexa");
          if (cfg.get<boolean>("showInlineFindings")) {
            this.services.diagnostics.addFinding(f);
          }
        } : undefined,
        onDone: (durationMs, promptTokens, completionTokens) => {
          this.panel?.webview.postMessage({
            type: "assistantDone",
            id: msgId,
            durationMs, promptTokens, completionTokens,
          });
        },
        token: this.tokenSource.token,
      });

      // Final render
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      const html = linkifyFileRefs(marked.parse(this.streamBuffer) as string);
      this.panel?.webview.postMessage({ type: "assistantChunk", id: msgId, html });

      // Store raw markdown for copy/save
      this.responseBuffers.set(msgId, this.streamBuffer);

      this.panel?.webview.postMessage({
        type: "assistantDone",
        id: msgId,
        durationMs: result.durationMs,
      });

      this.services.statusBar.setDone(`${parsed.label} complete`);

      // Add to sidebar history
      const historyCmd = (parsed.cliCommand === "query" && parsed.command === "explain") ? "query" : parsed.cliCommand;
      const validCmds = ["diagnose", "review", "query", "impact", "gist", "analyze"] as const;
      const cmd = validCmds.includes(historyCmd as typeof validCmds[number])
        ? historyCmd as typeof validCmds[number]
        : "query" as const;
      this.services.sidebar.addToHistory({
        id: crypto.randomUUID(),
        cmd,
        title: `${parsed.label} — ${text.slice(0, 48)}`,
        timestamp: Date.now(),
        markdown: this.streamBuffer,
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

  private parseSlashCommand(text: string): SlashCommand {

    // /review <file> or /review --changed
    if (text.startsWith("/review")) {
      const rest = text.slice(7).trim();
      if (rest === "--changed" || rest === "changes" || rest === "changed") {
        return { command: "review", cliCommand: "review", args: ["--changed"], label: "Review Changes" };
      }
      if (rest.startsWith("--")) {
        // Raw CLI flags passed directly (e.g. /review --target foo --branch main..HEAD)
        return { command: "review", cliCommand: "review", args: rest.split(/\s+/), label: `Review` };
      }
      if (rest) {
        return { command: "review", cliCommand: "review", args: ["--target", rest], label: `Review ${rest}` };
      }
      // No args — review current file
      const currentFile = this.getCurrentFileRelPath();
      if (currentFile) {
        return { command: "review", cliCommand: "review", args: ["--target", currentFile], label: `Review ${path.basename(currentFile)}` };
      }
      return { command: "review", cliCommand: "review", args: [], label: "Review" };
    }

    // /impact <file> [description]
    if (text.startsWith("/impact")) {
      const rest = text.slice(7).trim();
      if (rest.startsWith("--")) {
        return { command: "impact", cliCommand: "impact", args: rest.split(/\s+/), label: "Impact" };
      }
      const parts = rest.split(/\s+/);
      const target = parts[0] || this.getCurrentFileRelPath() || "";
      const query = parts.slice(1).join(" ");
      const args = target ? ["--target", target] : [];
      if (query) args.push("--query", query);
      return { command: "impact", cliCommand: "impact", args, label: `Impact ${target ? path.basename(target) : ""}` };
    }

    // /gist
    if (text.startsWith("/gist")) {
      return { command: "gist", cliCommand: "gist", args: [], label: "Gist" };
    }

    // /analyze
    if (text.startsWith("/analyze")) {
      return { command: "analyze", cliCommand: "analyze", args: [], label: "Analyze" };
    }

    // /diagnose <error text>
    if (text.startsWith("/diagnose")) {
      const rest = text.slice(9).trim();
      if (rest) {
        return { command: "diagnose", cliCommand: "diagnose", args: ["--error", rest.slice(0, 3000)], label: "Diagnose" };
      }
      return { command: "diagnose", cliCommand: "diagnose", args: [], label: "Diagnose" };
    }

    // Default: query
    return { command: "query", cliCommand: "query", args: ["--query", text], label: "Query" };
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
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { Markdown: ["md"] },
    });
    if (uri) {
      const dir = path.dirname(uri.fsPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      vscode.window.showInformationMessage(`Saved to ${uri.fsPath}`);
    }
  }

  private async openFileAtLine(filePath: string, line: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : workspaceRoot ? path.join(workspaceRoot, filePath) : filePath;
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
    <div class="chat-welcome">
      <h2>Archexa Chat</h2>
      <p>Ask anything about your codebase, or use slash commands for specific actions.</p>
      <div class="slash-examples">
        <span class="slash-example" data-cmd="/review ">/review</span>
        <span class="slash-example" data-cmd="/review --changed">/review changes</span>
        <span class="slash-example" data-cmd="/impact ">/impact</span>
        <span class="slash-example" data-cmd="/diagnose ">/diagnose</span>
        <span class="slash-example" data-cmd="/gist">/gist</span>
        <span class="slash-example" data-cmd="/analyze">/analyze</span>
      </div>
    </div>
  </div>

  <div class="chat-input-area">
    <div id="slashMenu" class="slash-menu" style="display:none"></div>
    <div class="input-row">
      <textarea id="chatInput" rows="1" placeholder="Ask about your codebase or use /command..."></textarea>
      <button id="sendBtn">Send</button>
      <button id="cancelBtn">Cancel</button>
    </div>
    <div class="input-hints">
      <span><span class="input-hint-key">Enter</span> send</span>
      <span><span class="input-hint-key">Shift+Enter</span> new line</span>
      <span><span class="input-hint-key">/</span> commands</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("sendBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const slashMenu = document.getElementById("slashMenu");
    let isStreaming = false;
    let slashMenuIdx = -1;

    // Slash command definitions
    const SLASH_CMDS = [
      { cmd: "/review", args: "<file>", desc: "Review file for issues" },
      { cmd: "/review --changed", args: "", desc: "Review uncommitted changes" },
      { cmd: "/impact", args: "<file> <change description>", desc: "Impact analysis" },
      { cmd: "/diagnose", args: "<error text>", desc: "Diagnose an error" },
      { cmd: "/query", args: "<question>", desc: "Ask about the codebase" },
      { cmd: "/gist", args: "", desc: "Quick codebase overview" },
      { cmd: "/analyze", args: "", desc: "Full architecture analysis" },
    ];

    // Auto-resize textarea
    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
      updateSlashMenu();
    });

    // Keyboard handling
    chatInput.addEventListener("keydown", (e) => {
      // Slash menu navigation
      if (slashMenu.style.display !== "none") {
        const items = slashMenu.querySelectorAll(".slash-item");
        if (e.key === "ArrowDown") { e.preventDefault(); slashMenuIdx = Math.min(slashMenuIdx + 1, items.length - 1); highlightSlashItem(items); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashMenuIdx = Math.max(slashMenuIdx - 1, 0); highlightSlashItem(items); return; }
        if ((e.key === "Enter" || e.key === "Tab") && slashMenuIdx >= 0 && items[slashMenuIdx]) {
          e.preventDefault();
          selectSlashItem(items[slashMenuIdx]);
          return;
        }
        if (e.key === "Escape") { slashMenu.style.display = "none"; return; }
      }
      // Send on Enter
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isStreaming && chatInput.value.trim()) sendMessage();
      }
    });

    function updateSlashMenu() {
      const val = chatInput.value;
      if (!val.startsWith("/") || val.includes(" ") || isStreaming) {
        slashMenu.style.display = "none";
        return;
      }
      const filter = val.toLowerCase();
      const matches = SLASH_CMDS.filter(c => c.cmd.startsWith(filter));
      if (matches.length === 0) { slashMenu.style.display = "none"; return; }
      slashMenu.innerHTML = matches.map((c, i) =>
        '<div class="slash-item' + (i === 0 ? ' active' : '') + '" data-cmd="' + c.cmd + '">'
        + '<span class="slash-cmd">' + c.cmd + '</span>'
        + (c.args ? ' <span class="slash-args">' + c.args + '</span>' : '')
        + '<span class="slash-desc">' + c.desc + '</span>'
        + '</div>'
      ).join("");
      slashMenuIdx = 0;
      slashMenu.style.display = "block";
      slashMenu.querySelectorAll(".slash-item").forEach(el => {
        el.addEventListener("click", () => selectSlashItem(el));
      });
    }

    function highlightSlashItem(items) {
      items.forEach((el, i) => el.classList.toggle("active", i === slashMenuIdx));
    }

    function selectSlashItem(el) {
      const cmd = el.dataset.cmd;
      chatInput.value = cmd + " ";
      chatInput.focus();
      slashMenu.style.display = "none";
    }

    sendBtn.addEventListener("click", () => {
      if (!isStreaming && chatInput.value.trim()) sendMessage();
    });

    cancelBtn.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "cancel" });
    });

    // Slash command examples (welcome screen)
    document.querySelectorAll(".slash-example").forEach(el => {
      el.addEventListener("click", () => {
        chatInput.value = el.dataset.cmd;
        chatInput.focus();
        chatInput.style.height = "auto";
        updateSlashMenu();
      });
    });

    // Delegated click handler for file links, copy, save
    document.addEventListener("click", (e) => {
      const link = e.target.closest(".file-link");
      if (link) {
        e.preventDefault();
        vscodeApi.postMessage({ type: "openFile", file: link.dataset.file, line: parseInt(link.dataset.line, 10) || 1 });
        return;
      }
      const copyBtn = e.target.closest(".msg-copy-btn");
      if (copyBtn) {
        vscodeApi.postMessage({ type: "copyMarkdown", msgId: copyBtn.dataset.msgid });
        return;
      }
      const saveBtn = e.target.closest(".msg-save-btn");
      if (saveBtn) {
        vscodeApi.postMessage({ type: "saveMarkdown", msgId: saveBtn.dataset.msgid });
        return;
      }
    });

    function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      vscodeApi.postMessage({ type: "send", text });
      chatInput.value = "";
      chatInput.style.height = "auto";
      slashMenu.style.display = "none";
    }

    function setStreaming(on) {
      isStreaming = on;
      sendBtn.style.display = on ? "none" : "block";
      cancelBtn.style.display = on ? "block" : "none";
      sendBtn.disabled = on;
      chatInput.disabled = on;
      if (!on) chatInput.focus();
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function removeWelcome() {
      const welcome = messagesEl.querySelector(".chat-welcome");
      if (welcome) welcome.remove();
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "userMessage": {
          removeWelcome();
          const div = document.createElement("div");
          div.className = "msg msg-user";
          const bubble = document.createElement("div");
          bubble.className = "msg-bubble";
          bubble.textContent = msg.text;
          div.appendChild(bubble);
          messagesEl.appendChild(div);
          scrollToBottom();
          break;
        }

        case "assistantStart": {
          setStreaming(true);
          const div = document.createElement("div");
          div.className = "msg msg-assistant msg-streaming";
          div.id = "msg-" + msg.id;
          div.innerHTML =
            '<div class="msg-meta"><span class="cmd-badge">' + (msg.label || "Query") + '</span></div>'
            + '<div class="agent-steps" id="steps-' + msg.id + '"></div>'
            + '<div class="msg-content"></div>'
            + '<div class="msg-toolbar" style="display:none">'
            + '  <button class="msg-copy-btn tb-sm" data-msgid="' + msg.id + '">Copy</button>'
            + '  <button class="msg-save-btn tb-sm" data-msgid="' + msg.id + '">Save</button>'
            + '</div>'
            + '<div class="msg-progress"><span class="spinner">&#x27F3;</span> <span class="progress-text">Starting...</span></div>';
          messagesEl.appendChild(div);
          scrollToBottom();
          break;
        }

        case "assistantChunk": {
          const el = document.getElementById("msg-" + msg.id);
          if (el) {
            el.querySelector(".msg-content").innerHTML = msg.html;
            scrollToBottom();
          }
          break;
        }

        case "progress": {
          const el = document.getElementById("msg-" + msg.id);
          if (el) {
            const pt = el.querySelector(".progress-text");
            if (pt) pt.textContent = "[" + msg.phase + "/" + msg.total + "] " + msg.label + (msg.detail ? " — " + msg.detail : "");
          }
          break;
        }

        case "assistantDone": {
          const el = document.getElementById("msg-" + msg.id);
          if (el) {
            el.classList.remove("msg-streaming");
            const prog = el.querySelector(".msg-progress");
            if (prog) prog.remove();
            // Collapse steps into a toggle
            const stepsEl = document.getElementById("steps-" + msg.id);
            if (stepsEl && stepsEl.children.length > 0) {
              stepsEl.classList.add("collapsed");
              const toggle = document.createElement("div");
              toggle.className = "steps-toggle";
              toggle.textContent = stepsEl.children.length + " investigation steps";
              toggle.addEventListener("click", () => stepsEl.classList.toggle("collapsed"));
              stepsEl.parentNode.insertBefore(toggle, stepsEl);
            }
            // Show toolbar
            const toolbar = el.querySelector(".msg-toolbar");
            if (toolbar) toolbar.style.display = "flex";
            // Add duration to meta
            if (msg.durationMs > 0) {
              const meta = el.querySelector(".msg-meta");
              if (meta) {
                const dur = document.createElement("span");
                dur.textContent = (msg.durationMs / 1000).toFixed(1) + "s";
                meta.appendChild(dur);
              }
            }
          }
          setStreaming(false);
          scrollToBottom();
          break;
        }

        case "assistantError": {
          const el = document.getElementById("msg-" + msg.id);
          if (el) {
            el.classList.remove("msg-streaming");
            el.classList.add("msg-error");
            const prog = el.querySelector(".msg-progress");
            if (prog) prog.remove();
            el.querySelector(".msg-content").textContent = msg.message;
          }
          setStreaming(false);
          scrollToBottom();
          break;
        }

        case "assistantCancelled": {
          const el = document.getElementById("msg-" + msg.id);
          if (el) {
            el.classList.remove("msg-streaming");
            const prog = el.querySelector(".msg-progress");
            if (prog) prog.remove();
            const meta = el.querySelector(".msg-meta");
            if (meta) {
              const tag = document.createElement("span");
              tag.textContent = "Cancelled";
              tag.style.color = "var(--vscode-descriptionForeground)";
              meta.appendChild(tag);
            }
          }
          setStreaming(false);
          break;
        }

        case "agentLog": {
          const stepsEl = document.getElementById("steps-" + msg.id);
          if (stepsEl) {
            const line = msg.line || "";
            const step = document.createElement("div");
            step.className = "agent-step";
            // Parse common patterns for rich rendering
            if (line.includes("agent.tool name=")) {
              const m = line.match(/name=(\\S+)\\s+args=(.+)/);
              if (m) {
                step.innerHTML = '<span class="step-icon">&#x25B8;</span> <span class="step-tool">' + m[1] + '</span><span class="step-args">' + m[2].replace(/</g,"&lt;") + '</span>';
              } else {
                step.textContent = line;
              }
            } else if (line.includes("agent.investigate iteration=")) {
              const iter = line.match(/iteration=(\\d+)/);
              step.innerHTML = '<span class="step-icon">&#x25CB;</span> <span class="step-iter">Iteration ' + (iter ? iter[1] : "") + '</span>';
            } else if (line.includes("agent.investigate done")) {
              const m = line.match(/iterations=(\\d+)\\s+tool_calls=(\\d+)/);
              step.innerHTML = '<span class="step-icon">&#x2713;</span> <span class="step-done">Investigation done' + (m ? " — " + m[1] + " iterations, " + m[2] + " tool calls" : "") + '</span>';
            } else if (line.includes("agent.scaling")) {
              const m = line.match(/files=(\\d+).*max_iter=(\\d+)/);
              step.innerHTML = '<span class="step-icon">&#x2699;</span> <span class="step-scale">' + (m ? m[1] + " files, max " + m[2] + " iterations" : line) + '</span>';
            } else if (line.includes("progressive_prune")) {
              const m = line.match(/(\\d+) -> (\\d+) tokens \\(-(\\d+)\\)/);
              step.innerHTML = '<span class="step-icon">&#x2702;</span> <span class="step-prune">Pruned ' + (m ? m[3] + " tokens" : "") + '</span>';
            } else if (line.includes("synthesis.dedup")) {
              step.innerHTML = '<span class="step-icon">&#x2261;</span> <span class="step-dedup">' + line.replace(/^.*INFO\\s+/, "") + '</span>';
            } else if (line.includes("agent.synthesize")) {
              step.innerHTML = '<span class="step-icon">&#x270E;</span> <span class="step-synth">Generating response...</span>';
            } else if (line.includes("agent.nudge")) {
              return; // skip nudge lines
            } else {
              return; // skip unrecognized lines
            }
            stepsEl.appendChild(step);
            scrollToBottom();
          }
          break;
        }

        case "copyConfirm": {
          const el = document.getElementById("msg-" + msg.msgId);
          if (el) {
            const btn = el.querySelector(".msg-copy-btn");
            if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
          }
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
