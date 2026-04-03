import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { marked } from "marked";
import { ArchexaBridge, ReviewFinding } from "./bridge.js";
import { DiagnosticsManager } from "./diagnosticsManager.js";
import { StatusBarItem } from "./statusBarItem.js";
import { Logger } from "./utils/logger.js";
import { getNonce } from "./utils/platform.js";
import { generateConfigYaml } from "./utils/config.js";

export interface HistoryEntry {
  id: string;
  cmd: "diagnose" | "review" | "query" | "impact" | "gist" | "analyze";
  title: string;
  timestamp: number;
  markdown: string;
  filePath?: string;
  question?: string;
}

export interface ChatServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  logger: Logger;
  extensionUri: vscode.Uri;
}

interface ParsedCommand {
  command: string;
  cliCommand: string;
  args: string[];
  label: string;
  icon: string;
}

function getMaxHistory(): number {
  return vscode.workspace.getConfiguration("archexa").get<number>("maxHistory") ?? 30;
}

const CMD_ICONS: Record<string, string> = {
  diagnose: "\u25CF", review: "\u25CE", query: "\u25C6",
  impact: "\u25C7", gist: "\u25AA", analyze: "\u25AB",
};

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

function detectIntent(text: string): string | null {
  const s = text.toLowerCase();
  if (/\berror\b|exception|failing|crash|why is|traceback|not work|decode|typeerror|stacktrace/.test(s)) return "diagnose";
  if (/\breview\b|check|securi|bug|vulnerab|\bsql\b|jwt|audit|issues?\b/.test(s)) return "review";
  if (/\bexplain\b|what (does|is)|how does|understand|purpose|walk me/.test(s)) return "explain";
  if (/\bimpact\b|what breaks|what happens if|change|affect|downstream/.test(s)) return "impact";
  return null;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  // Chat state
  private tokenSource: vscode.CancellationTokenSource | undefined;
  private streamBuffer = "";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private responseBuffers = new Map<string, string>();
  private logLines = new Map<string, string[]>();

  // Settings state
  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  // Services (set after binary check)
  private services: ChatServices | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Called by extension.ts after services are available (post binary check) */
  setServices(services: ChatServices): void {
    this.services = services;
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };

    const chatCssUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "chat.css")
    );

    const nonce = getNonce();
    view.webview.html = this.getHtml(chatCssUri, nonce);
    this.refresh();

    view.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this.onMessage(msg)
    );

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("archexa")) {
        this.refresh();
        this.sendConfig();
      }
    });
  }

  // ─── Message router ───────────────────────────────────────

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      // ── Sidebar (home) ──
      case "runCommand":
        if (typeof msg.command === "string") void vscode.commands.executeCommand(msg.command);
        break;
      case "openResult":
        if (msg.entry) void vscode.commands.executeCommand("archexa.reopenResult", msg.entry as HistoryEntry);
        break;
      case "clearHistory":
        this.clearHistory();
        break;
      case "cancelRun":
        void vscode.commands.executeCommand("archexa.cancelCurrentRun");
        break;

      // ── Chat ──
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
            this.postMessage({ type: "copyConfirm", msgId: msg.msgId });
          }
        }
        break;
      case "saveMarkdown":
        if (typeof msg.msgId === "string") void this.saveMarkdown(msg.msgId);
        break;
      case "getContext":
        this.sendEditorContext();
        break;
      case "fileComplete":
        if (typeof msg.prefix === "string") void this.handleFileComplete(msg.prefix as string);
        break;

      // ── Settings ──
      case "showSettings":
        this.postMessage({ type: "showScreen", screen: "settings" });
        this.sendConfig();
        break;
      case "goBack":
        this.postMessage({ type: "showScreen", screen: "home" });
        break;
      case "update": {
        const key = msg.key as string;
        const value = msg.value;
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
        this.scheduleSyncConfigFile();
        break;
      }
      case "save":
        this.syncConfigFile();
        this.postMessage({ type: "saveConfirmed" });
        break;
      case "verifyBinary": {
        const binPath = vscode.workspace
          .getConfiguration("archexa")
          .get<string>("binaryPath");
        if (binPath) {
          try {
            const { execSync } = await import("child_process");
            const out = execSync(`"${binPath}" --version`, { timeout: 5000 })
              .toString()
              .trim();
            vscode.window.showInformationMessage(`Archexa binary: ${out}`);
          } catch {
            vscode.window.showErrorMessage("Binary verification failed");
          }
        }
        break;
      }
      case "checkUpdate":
        await vscode.commands.executeCommand("archexa.checkBinary");
        this.sendConfig();
        break;
      case "redownload":
        await vscode.commands.executeCommand("archexa.checkBinary");
        this.sendConfig();
        break;
      case "openBinFolder": {
        const binPath = vscode.workspace
          .getConfiguration("archexa")
          .get<string>("binaryPath");
        if (binPath) {
          const dir = path.dirname(binPath);
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
        }
        break;
      }
      case "testConnection":
        await this.testConnection();
        break;
      case "clearCache":
        vscode.window.showInformationMessage("Cache cleared");
        break;
    }
  }

  // ─── Sidebar public API ───────────────────────────────────

  showProgress(label: string, pct: number): void {
    this.postMessage({ type: "progress", label, pct });
  }

  hideProgress(): void {
    this.postMessage({ type: "progressDone" });
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

  /** Show settings screen in sidebar (called from command palette) */
  showSettings(): void {
    this.postMessage({ type: "showScreen", screen: "settings" });
    this.sendConfig();
  }

  refresh(): void {
    if (!this.view) return;
    this.hideProgress();
    const cfg = vscode.workspace.getConfiguration("archexa");
    const model = cfg.get<string>("model") ?? "gpt-4o";
    const deep = cfg.get<boolean>("deepByDefault") !== false;
    const version = cfg.get<string>("binaryVersion") ?? "";
    const apiKey = cfg.get<string>("apiKey") || process.env.OPENAI_API_KEY || "";
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
    const entries = this.ctx.workspaceState.get<HistoryEntry[]>("archexa.history", []);

    this.postMessage({
      type: "update",
      model, deep, version, workspace,
      hasKey: !!apiKey,
      history: entries.map((e) => ({
        ...e,
        title: e.title.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").trim(),
        icon: CMD_ICONS[e.cmd] ?? "\u00B7",
        relTime: this.relativeTime(e.timestamp),
        group: this.dateGroup(e.timestamp),
      })),
    });
  }

  // ─── Chat methods ─────────────────────────────────────────

  private async handleFileComplete(prefix: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    let files: string[] = [];

    // Try git first — fast, respects .gitignore, includes untracked non-ignored files
    for (const folder of folders) {
      try {
        const cp = await import("child_process");
        // --cached = tracked files, --others --exclude-standard = untracked but not gitignored
        const out = cp.execSync("git ls-files --cached --others --exclude-standard", {
          cwd: folder.uri.fsPath, timeout: 3000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        });
        const folderFiles = out.split("\n").filter(Boolean);
        // For multi-root, prefix with folder name
        if (folders.length > 1) {
          files.push(...folderFiles.map(f => `${folder.name}/${f}`));
        } else {
          files.push(...folderFiles);
        }
      } catch {
        // Not a git repo or git not installed — fallback to findFiles for this folder
        const glob = new vscode.RelativePattern(folder, prefix.includes("/") ? `${prefix}**` : `**/${prefix}**`);
        try {
          const uris = await vscode.workspace.findFiles(glob, undefined, 50);
          files.push(...uris.map(u => vscode.workspace.asRelativePath(u)));
        } catch { /* skip this folder */ }
      }
    }

    const matches = files
      .filter(f => f.includes(prefix))
      .sort()
      .slice(0, 10);

    this.postMessage({ type: "fileCompleteResults", files: matches, prefix });
  }

  private sendEditorContext(): void {
    const editor = vscode.window.activeTextEditor;
    const file = editor?.document.uri.scheme === "file"
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : undefined;
    const selection = editor?.selection;
    const hasSelection = selection && !selection.isEmpty;
    const selText = hasSelection ? editor!.document.getText(selection).split("\n")[0].slice(0, 40) : undefined;
    this.postMessage({
      type: "editorContext",
      file: file ? path.basename(file) : undefined,
      filePath: file,
      selection: selText,
    });
  }

  private cancelCurrentRun(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel();
      this.tokenSource.dispose();
      this.tokenSource = undefined;
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!this.services) {
      vscode.window.showWarningMessage("Archexa services not ready. Please wait for initialization.");
      return;
    }

    const parsed = this.parseCommand(text);
    const msgId = Date.now().toString();

    this.postMessage({ type: "userMessage", text });
    this.postMessage({
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
          this.postMessage({ type: "chatProgress", id: msgId, phase, total, label, detail });
        },
        onFinding: parsed.cliCommand === "review" ? (f: ReviewFinding) => {
          const cfg = vscode.workspace.getConfiguration("archexa");
          if (cfg.get<boolean>("showInlineFindings")) this.services!.diagnostics.addFinding(f);
          this.postMessage({ type: "finding", id: msgId, finding: f });
        } : undefined,
        onLog: (line) => {
          this.logLines.get(msgId)?.push(line);
          this.postMessage({ type: "agentLog", id: msgId, line });
        },
        onDone: (durationMs, promptTokens, completionTokens) => {
          this.postMessage({ type: "assistantDone", id: msgId, durationMs, promptTokens, completionTokens });
        },
        token: this.tokenSource.token,
      });

      // Final render
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      const html = linkifyFileRefs(marked.parse(this.streamBuffer) as string);
      this.postMessage({ type: "assistantChunk", id: msgId, html });
      this.responseBuffers.set(msgId, this.streamBuffer);

      this.postMessage({ type: "assistantDone", id: msgId, durationMs: result.durationMs });
      this.services.statusBar.setDone(`${parsed.label} complete`);

      // History
      const validCmds = ["diagnose", "review", "query", "impact", "gist", "analyze"] as const;
      const cmd = validCmds.includes(parsed.cliCommand as typeof validCmds[number])
        ? parsed.cliCommand as typeof validCmds[number] : "query" as const;
      this.addToHistory({
        id: crypto.randomUUID(), cmd,
        title: `${parsed.label} \u2014 ${text.slice(0, 48)}`,
        timestamp: Date.now(), markdown: this.streamBuffer,
      });
    } catch (err: unknown) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.tokenSource?.token.isCancellationRequested) {
        this.postMessage({ type: "assistantCancelled", id: msgId });
        this.services.statusBar.setIdle();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage({ type: "assistantError", id: msgId, message });
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
      this.postMessage({ type: "assistantChunk", id: msgId, html });
    }, 80);
  }

  private parseCommand(text: string): ParsedCommand {
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
    if (text.startsWith("/diagnose")) {
      const rest = text.slice(9).trim();
      return rest
        ? { command: "diagnose", cliCommand: "diagnose", args: ["--error", rest.slice(0, 3000)], label: "Diagnose", icon: "bug" }
        : { command: "diagnose", cliCommand: "diagnose", args: [], label: "Diagnose", icon: "bug" };
    }
    if (text.startsWith("/gist")) return { command: "gist", cliCommand: "gist", args: [], label: "Gist", icon: "book" };
    if (text.startsWith("/analyze")) return { command: "analyze", cliCommand: "analyze", args: [], label: "Analyze", icon: "graph" };
    if (text.startsWith("/query")) {
      const rest = text.slice(6).trim();
      return { command: "query", cliCommand: "query", args: ["--query", rest || text], label: "Query", icon: "comment" };
    }

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

  // ─── Settings methods ─────────────────────────────────────

  private sendConfig(): void {
    const cfg = vscode.workspace.getConfiguration("archexa");
    const config: Record<string, unknown> = {};
    const props = [
      "apiKey", "model", "endpoint", "binaryPath", "binaryVersion",
      "deepByDefault", "deepMaxIterations", "cacheEnabled",
      "showInlineFindings", "autoReviewOnSave", "clearFindingsOnNewReview",
      "showTokenUsage", "outputDir",
      "promptBudget", "promptReserve", "maxFiles", "fileSizeLimit", "maxHistory",
      "logLevel", "tlsVerify",
      "promptDiagnose", "promptReview", "promptQuery", "promptImpact", "promptGist", "promptAnalyze",
      "excludePatterns", "scanFocus", "reviewTarget",
    ];
    for (const prop of props) {
      config[prop] = cfg.get(prop);
    }
    this.postMessage({ type: "init", config });
  }

  private scheduleSyncConfigFile(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.syncConfigFile(), 1000);
  }

  private syncConfigFile(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;
    const configPath = path.join(workspaceRoot, "archexa.yaml");
    fs.writeFileSync(configPath, generateConfigYaml(), "utf8");
    vscode.window.showInformationMessage(`Saved ${configPath}`);
  }

  private async testConnection(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("archexa");
    const apiKey = cfg.get<string>("apiKey") || process.env.OPENAI_API_KEY || "";
    const endpoint = cfg.get<string>("endpoint") || "https://api.openai.com/v1/";
    const model = cfg.get<string>("model") || "gpt-4o";

    if (!apiKey) {
      this.sendConnResult(false, "No API key set. Enter a key above or set OPENAI_API_KEY env var.");
      return;
    }

    this.sendConnResult(false, "Sending test request to chat/completions...", true);

    try {
      const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";
      const url = new URL("chat/completions", base).toString();
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 5,
      });

      const result = await this.httpPost(url, apiKey, body);
      const parsed = JSON.parse(result.body) as Record<string, unknown>;

      if (result.status >= 200 && result.status < 300 && Array.isArray(parsed.choices)) {
        const choices = parsed.choices as Array<Record<string, unknown>>;
        const firstMsg = choices[0]?.message as Record<string, string> | undefined;
        const reply = firstMsg?.content ?? "";
        this.sendConnResult(true,
          `Model "${model}" responded: "${reply.trim().slice(0, 30)}". Endpoint: ${new URL(url).host}`
        );
      } else if (result.status === 401) {
        this.sendConnResult(false, "Authentication failed (401). Check your API key.");
      } else if (result.status === 404) {
        const errMsg = (parsed.error as Record<string, string>)?.message ?? "";
        this.sendConnResult(false,
          `Model or endpoint not found (404). ${errMsg ? errMsg.slice(0, 150) : "Check Base URL and Model name."}`
        );
      } else if (result.status === 400) {
        const errMsg = (parsed.error as Record<string, string>)?.message ?? "";
        this.sendConnResult(false, `Bad request (400): ${errMsg.slice(0, 200)}`);
      } else {
        const errMsg = (parsed.error as Record<string, string>)?.message ?? result.body.slice(0, 200);
        this.sendConnResult(false, `HTTP ${result.status}: ${errMsg}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) {
        this.sendConnResult(false, `Cannot reach endpoint. Check the Base URL is correct.`);
      } else if (message.includes("timed out")) {
        this.sendConnResult(false, `Request timed out (15s). Endpoint may be down or unreachable.`);
      } else {
        this.sendConnResult(false, `Connection failed: ${message}`);
      }
    }
  }

  private sendConnResult(ok: boolean, message: string, pending = false): void {
    this.postMessage({ type: "connResult", ok, message, pending });
  }

  private httpPost(
    url: string,
    apiKey: string,
    body: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === "https:" ? https : http;
      const options = {
        method: "POST",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "archexa-vscode",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      };
      const req = mod.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out (15s)"));
      });
      req.write(body);
      req.end();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private postMessage(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
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

  // ─── HTML ─────────────────────────────────────────────────

  private getHtml(cssUri: vscode.Uri, nonce: string): string {
    const csp = this.view!.webview.cspSource;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${csp} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
  <style nonce="${nonce}">
    /* ── Screen switching ── */
    .screen { display: none; }
    .screen.active { display: flex; flex-direction: column; }

    /* ── Sidebar-specific styles (from sidebar.css) ── */
    .status-card {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.ok { background: var(--vscode-terminal-ansiGreen, #4ec966); }
    .status-dot.warn { background: var(--vscode-editorWarning-foreground, #cca700); }
    .status-dot.err { background: var(--vscode-errorForeground, #f44747); }
    .status-label { color: var(--vscode-descriptionForeground); }
    .status-value {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .cmd-badge {
      font-size: 9px; padding: 0 5px; border-radius: 3px;
      font-weight: 600; line-height: 16px; flex-shrink: 0;
    }
    .cmd-badge.deep {
      background: rgba(78, 201, 102, 0.15);
      color: var(--vscode-terminal-ansiGreen, #4ec966);
    }
    .cmd-badge.pipeline {
      background: rgba(255, 204, 2, 0.12);
      color: var(--vscode-editorWarning-foreground, #cca700);
    }

    /* History in home screen */
    .section-header {
      padding: 8px 12px 4px;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-editorGroup-border);
      margin-top: 4px; user-select: none;
    }
    .history-empty {
      padding: 16px 12px; text-align: center;
      color: var(--vscode-disabledForeground); font-size: 11px;
    }
    .history-item {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; cursor: pointer; font-size: 11px;
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground); }
    .history-icon { font-size: 12px; flex-shrink: 0; width: 16px; text-align: center; }
    .history-title {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .history-time {
      font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0;
    }
    .history-group {
      padding: 6px 12px 2px; font-size: 10px; font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase; letter-spacing: 0.5px;
    }

    /* Clear + gear buttons */
    .clear-btn, .gear-btn {
      cursor: pointer; font-size: 10px; text-transform: none;
      letter-spacing: 0; font-weight: 400;
      color: var(--vscode-descriptionForeground);
      padding: 2px 8px; border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      border: none;
    }
    .clear-btn:hover, .gear-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    /* Progress bar */
    .progress-section {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-editor-lineHighlightBackground);
    }
    .progress-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; margin-bottom: 6px;
    }
    .progress-spinner { animation: spin 1s linear infinite; display: inline-block; }
    .progress-cancel {
      margin-left: auto; cursor: pointer; font-size: 10px;
      color: var(--vscode-errorForeground, #f44747);
      padding: 1px 6px; border-radius: 3px;
      background: rgba(244, 71, 71, 0.1);
    }
    .progress-cancel:hover { background: rgba(244, 71, 71, 0.2); }
    .progress-track {
      height: 3px; background: var(--vscode-editorGroup-border);
      border-radius: 2px; overflow: hidden;
    }
    .progress-fill {
      height: 100%; background: var(--vscode-progressBar-background);
      border-radius: 2px; transition: width 0.4s; width: 0%;
    }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    /* ── Settings styles ── */
    .settings-scroll {
      flex: 1; overflow-y: auto; padding: 12px;
    }
    .settings-top-bar {
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      padding: 0 12px; height: 34px;
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    .settings-top-bar .back-btn {
      background: none; border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer; font-size: 12px; padding: 0;
    }
    .settings-top-bar .back-btn:hover { color: var(--vscode-editor-foreground); }
    .settings-top-bar .title {
      color: var(--vscode-editor-foreground); font-size: 12.5px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .settings-top-bar .spacer { flex: 1; }

    /* ── Tab bar ── */
    .settings-tab-bar {
      display: flex; gap: 0; border-bottom: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-sideBar-background); flex-shrink: 0;
      padding: 0 12px;
    }
    .settings-tab {
      padding: 7px 14px; font-size: 11px; font-weight: 600;
      color: var(--vscode-descriptionForeground); cursor: pointer;
      border-bottom: 2px solid transparent; user-select: none;
      transition: color 0.12s, border-color 0.12s;
    }
    .settings-tab:hover { color: var(--vscode-editor-foreground); }
    .settings-tab.active {
      color: var(--vscode-textLink-foreground);
      border-bottom-color: var(--vscode-textLink-foreground);
    }

    .settings-tab-content { display: none; }
    .settings-tab-content.active { display: block; }

    .section-label {
      color: var(--vscode-descriptionForeground); font-size: 9.5px;
      text-transform: uppercase; letter-spacing: 1px; font-weight: 600;
      margin-bottom: 8px; margin-top: 14px;
    }
    .section-label:first-child { margin-top: 0; }

    .field { margin-bottom: 12px; }
    .field-row {
      display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;
    }
    .field-label { color: var(--vscode-editor-foreground); font-size: 12px; }
    .field-required { color: var(--vscode-errorForeground); font-size: 10px; }
    .field-hint { color: var(--vscode-descriptionForeground); font-size: 10.5px; margin-top: 3px; line-height: 1.4; }

    .settings-scroll input[type="text"],
    .settings-scroll input[type="password"],
    .settings-scroll input[type="number"] {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 5px; padding: 7px 9px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11.5px; outline: none; transition: border-color .12s;
    }
    .settings-scroll input:focus, .settings-scroll textarea:focus { border-color: var(--vscode-focusBorder); }
    .settings-scroll input::placeholder, .settings-scroll textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .settings-scroll select {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 5px; padding: 7px 9px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11.5px; outline: none; transition: border-color .12s;
      cursor: pointer;
    }
    .settings-scroll select:focus { border-color: var(--vscode-focusBorder); }

    .settings-input-row { display: flex; gap: 6px; }
    .settings-input-row input { flex: 1; }

    .show-hide-btn {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 5px; padding: 7px 10px; font-size: 11px;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
    }
    .show-hide-btn:hover { color: var(--vscode-editor-foreground); }

    .info-box {
      background: rgba(56,139,253,.06);
      border-left: 3px solid var(--vscode-textLink-foreground);
      border-radius: 0 4px 4px 0;
      padding: 7px 10px; margin-bottom: 12px;
      font-size: 10.5px; line-height: 1.5;
      color: var(--vscode-descriptionForeground);
    }
    .info-box code {
      background: var(--vscode-textCodeBlock-background);
      padding: 0 3px; border-radius: 2px; font-size: 9.5px;
      font-family: var(--vscode-editor-font-family);
    }
    .info-box strong { color: var(--vscode-editor-foreground); }

    .btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .btn-primary {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; border-radius: 5px; padding: 5px 14px;
      font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px; padding: 3px 9px; font-size: 10.5px; cursor: pointer;
    }
    .btn-secondary:hover { background: var(--vscode-list-hoverBackground); }

    #connStatus {
      margin-top: 8px; font-size: 11px; padding: 8px 12px;
      border-radius: 5px; display: none;
    }

    .toggle-row {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding: 8px 0; border-bottom: 1px solid rgba(48,54,61,.1);
    }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-info { padding-right: 16px; flex: 1; }
    .toggle-label { color: var(--vscode-editor-foreground); font-size: 12px; }
    .toggle-hint { color: var(--vscode-descriptionForeground); font-size: 10.5px; margin-top: 2px; line-height: 1.4; }
    .toggle-track {
      width: 32px; height: 17px; border-radius: 9px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-editorGroup-border);
      cursor: pointer; position: relative; transition: all .18s;
      flex-shrink: 0; margin-top: 2px;
    }
    .toggle-track.on {
      background: var(--vscode-textLink-foreground);
      border-color: var(--vscode-textLink-foreground);
    }
    .toggle-thumb {
      position: absolute; top: 2px; left: 2px;
      width: 11px; height: 11px; border-radius: 50%;
      background: var(--vscode-descriptionForeground); transition: left .18s;
    }
    .toggle-track.on .toggle-thumb { left: 17px; background: #fff; }

    /* Prompt editor — expandable card */
    .prompt-editor {
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 5px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    .prompt-editor-header {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px;
      background: var(--vscode-editor-lineHighlightBackground);
      cursor: default;
    }
    .prompt-cmd-icon { opacity: 0.6; display: flex; align-items: center; }
    .prompt-editor-name {
      font-size: 11.5px; font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    .prompt-badge {
      background: var(--vscode-textLink-foreground);
      color: #fff; font-size: 8.5px; font-weight: 700;
      padding: 0 5px; border-radius: 3px;
      text-transform: uppercase; letter-spacing: 0.3px;
    }
    .prompt-chars {
      color: var(--vscode-descriptionForeground);
      font-size: 9.5px; font-family: var(--vscode-editor-font-family);
    }
    .prompt-expand-btn {
      margin-left: auto;
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px; padding: 3px 10px;
      font-size: 10.5px; cursor: pointer;
      transition: background .12s;
    }
    .prompt-expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .prompt-editor-body {
      padding: 8px 10px;
      animation: fadeSlideUp .12s ease-out;
    }
    .prompt-editor-footer {
      display: flex; justify-content: space-between;
      align-items: center; margin-top: 4px;
    }
    .prompt-chars-bottom {
      color: var(--vscode-descriptionForeground);
      font-size: 9.5px; font-family: var(--vscode-editor-font-family);
    }
    textarea.prompt-area {
      width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      font-size: 11px; padding: 8px 10px; outline: none;
      font-family: var(--vscode-editor-font-family);
      resize: vertical; line-height: 1.6;
      min-height: 90px;
      transition: border-color .12s;
    }
    textarea.prompt-area:focus { border-color: var(--vscode-focusBorder); }

    /* Prompt full-screen modal */
    .prompt-modal {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--vscode-editor-background);
      z-index: 200;
      display: flex; flex-direction: column;
      animation: fadeSlideUp .15s ease-out;
    }
    .prompt-modal-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-sideBar-background);
      flex-shrink: 0;
    }
    .prompt-modal-close {
      background: none; border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px; width: 28px; height: 28px;
      cursor: pointer; font-size: 14px;
      display: flex; align-items: center; justify-content: center;
      transition: background .12s;
    }
    .prompt-modal-close:hover { background: var(--vscode-list-hoverBackground); }
    .prompt-modal-title {
      font-size: 12.5px; font-weight: 700;
      color: var(--vscode-editor-foreground); flex: 1;
    }
    .prompt-modal-chars {
      font-size: 9.5px; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
    }
    .prompt-modal-save {
      padding: 5px 14px !important; font-size: 11px !important;
    }
    .prompt-modal-body {
      flex: 1; padding: 12px; display: flex;
    }
    .prompt-modal-textarea {
      flex: 1; width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 5px;
      color: var(--vscode-input-foreground);
      font-size: 12px; padding: 12px 14px; outline: none;
      font-family: var(--vscode-editor-font-family);
      resize: none; line-height: 1.7;
      transition: border-color .12s;
    }
    .prompt-modal-textarea:focus { border-color: var(--vscode-focusBorder); }
    .prompt-modal-footer {
      padding: 6px 12px;
      border-top: 1px solid var(--vscode-editorGroup-border);
      flex-shrink: 0;
    }

    .warning-box {
      color: var(--vscode-editorWarning-foreground, #d29922); font-size: 10.5px;
      background: rgba(210,153,34,.06);
      border-left: 3px solid var(--vscode-editorWarning-foreground, #d29922);
      border-radius: 0 4px 4px 0;
      padding: 7px 10px; margin-bottom: 14px; line-height: 1.5;
    }

    .grid-2col {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }
    .grid-field { }
    .grid-field label {
      display: block; color: var(--vscode-editor-foreground); font-size: 11.5px; margin-bottom: 4px;
    }
    .grid-field .field-hint { margin-top: 2px; }

    .bin-path {
      color: var(--vscode-terminal-ansiGreen, #3fb950); font-size: 10px;
      font-family: var(--vscode-editor-font-family);
      opacity: .7; word-break: break-all; margin-bottom: 6px;
    }

    .prompt-indicator {
      display: inline-block; width: 6px; height: 6px;
      border-radius: 50%; margin-right: 2px; vertical-align: middle;
    }
    .prompt-indicator.unset { background: var(--vscode-editorGroup-border); }
    .prompt-indicator.set { background: var(--vscode-terminal-ansiGreen, #3fb950); }

    .save-toast {
      display: none; position: fixed; bottom: 16px; right: 16px;
      background: var(--vscode-terminal-ansiGreen, #3fb950); color: #000;
      padding: 6px 16px; border-radius: 5px; font-size: 12px;
      font-weight: 600; z-index: 100;
    }

    .settings-save-row {
      display: flex; justify-content: flex-end; padding-top: 10px;
      margin-top: 6px; border-top: 1px solid var(--vscode-editorGroup-border);
    }
    .settings-save-row .save-btn {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; border-radius: 5px; padding: 5px 16px;
      font-size: 11px; font-weight: 600; cursor: pointer;
      min-width: 50px; transition: background .2s;
    }
    .settings-save-row .save-btn:hover { background: var(--vscode-button-hoverBackground); }
    .settings-save-row .save-btn.saved { background: var(--vscode-terminal-ansiGreen, #3fb950); }

    /* ── Home screen layout ── */
    #screen-home {
      height: 100vh;
    }
    #screen-home .home-scroll {
      flex: 1; overflow-y: auto; overflow-x: hidden;
    }

    /* ── Chat screen layout ── */
    #screen-chat {
      height: 100vh;
    }

    /* ── Settings screen ── */
    #screen-settings {
      height: 100vh;
    }
  </style>
</head>
<body>

  <!-- ═══════════════════════════════════════════════════════
       SCREEN: HOME (command cards + history)
       ═══════════════════════════════════════════════════════ -->
  <div id="screen-home" class="screen active">
    <div class="home-scroll">
      <!-- Status -->
      <div class="status-card" id="statusCard" style="display:none">
        <div class="status-row">
          <span class="status-dot" id="statusDot"></span>
          <span class="status-value" id="statusText"></span>
        </div>
        <div class="status-row">
          <span class="status-value" id="modelName" style="opacity:0.7">...</span>
        </div>
        <div class="status-row">
          <span id="modeBadge"></span>
          <span style="margin-left:auto" class="status-label" id="versionLabel"></span>
          <button class="gear-btn" id="gearBtn">\u2699 Settings</button>
        </div>
      </div>

      <!-- Progress (shown during active run) -->
      <div id="progressSection" class="progress-section" style="display:none">
        <div class="progress-row">
          <span class="progress-spinner">\u27F3</span>
          <span id="progressLabel">Running...</span>
          <span id="progressCancelBtn" class="progress-cancel">Cancel</span>
        </div>
        <div class="progress-track">
          <div id="progressFill" class="progress-fill"></div>
        </div>
      </div>

      <!-- Hero + Commands -->
      <div class="home-hero">
        <h2>Understand your code</h2>
        <p>Independent investigations. No memory. Just accurate answers.</p>
      </div>
      <div id="primaryCards" class="cmd-cards"></div>
      <div id="moreToggle" class="more-toggle">\u25B6 More actions</div>
      <div id="secondaryCards" class="cmd-cards cmd-cards-secondary" style="display:none"></div>

      <!-- History -->
      <div class="section-header" style="display:flex;align-items:center;justify-content:space-between;padding-right:12px">
        <span>Recent Results</span>
        <span id="clearHistoryBtn" class="clear-btn">Clear</span>
      </div>
      <div id="historyContainer">
        <div class="history-empty">No results yet. Run a command to get started.</div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════
       SCREEN: CHAT (messages + streaming)
       ═══════════════════════════════════════════════════════ -->
  <div id="screen-chat" class="screen">
    <div class="chat-messages" id="messages"></div>
  </div>

  <!-- ═══════════════════════════════════════════════════════
       SCREEN: SETTINGS
       ═══════════════════════════════════════════════════════ -->
  <div id="screen-settings" class="screen">
    <div class="settings-top-bar">
      <button class="back-btn" id="settingsBackBtn">\u2190</button>
      <span class="title">Settings</span>
      <span id="connBadge" style="display:none;font-size:9.5px;padding:1px 7px;border-radius:10px;margin-left:6px"></span>
      <span class="spacer"></span>
    </div>
    <div class="settings-tab-bar">
      <div class="settings-tab active" data-tab="connect">Connect</div>
      <div class="settings-tab" data-tab="behaviour">Behaviour</div>
      <div class="settings-tab" data-tab="prompts">Prompts</div>
      <div class="settings-tab" data-tab="advanced">Advanced</div>
    </div>
    <div class="settings-scroll">

      <!-- ── CONNECT TAB ── -->
      <div class="settings-tab-content active" id="tab-connect">
        <div class="section-label">API Key</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">API Key</div>
          <div class="settings-input-row">
            <input type="password" id="apiKey" data-key="archexa.apiKey" placeholder="sk-..."/>
            <button class="show-hide-btn" id="toggleApiKey">Show</button>
          </div>
          <div class="field-hint">Leave empty to use the OPENAI_API_KEY environment variable instead.</div>
        </div>

        <div class="section-label">Endpoint</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Base URL</div>
          <input type="text" id="settingsEndpoint" data-key="archexa.endpoint" placeholder="https://api.openai.com/v1/"/>
          <div class="info-box" style="margin-top:8px">
            Works with any OpenAI-compatible endpoint that supports <code>POST /chat/completions</code>.
            Examples: <code>https://api.openai.com/v1/</code> \u00B7 <code>https://openrouter.ai/api/v1/</code> \u00B7 <code>http://localhost:11434/v1/</code> \u00B7 <code>http://localhost:8000/v1/</code>
          </div>
        </div>

        <div class="section-label">Model</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Model name</div>
          <input type="text" id="settingsModel" data-key="archexa.model" placeholder="e.g. gpt-4o, gemini-2.5-flash, llama3.1"/>
          <div class="field-hint">Full model string as your provider expects it. Must support chat/completions with streaming.</div>
        </div>

        <div class="section-label">Security</div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">TLS verification</div>
            <div class="toggle-hint">Disable only for local endpoints with self-signed certificates.</div>
          </div>
          <div class="toggle-track on" data-key="archexa.tlsVerify" id="tlsToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>

        <div class="section-label">Connection Test</div>
        <div class="btn-row">
          <button class="btn-primary" id="btnTestConn">Test Connection</button>
        </div>
        <div id="connStatus"></div>

        <div class="settings-save-row">
          <button class="save-btn" id="settingsSaveBtn">Save</button>
        </div>
      </div>

      <!-- ── BEHAVIOUR TAB ── -->
      <div class="settings-tab-content" id="tab-behaviour">
        <div class="section-label">Investigation Mode</div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Deep mode by default</div>
            <div class="toggle-hint">Agent reads files, greps codebase, and traces calls before answering. More accurate, slower. Disable for quick pipeline-mode runs.</div>
          </div>
          <div class="toggle-track on" data-key="archexa.deepByDefault" id="deepToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Cache evidence between runs</div>
            <div class="toggle-hint">Reuses tree-sitter results and file reads for faster repeat queries on the same codebase.</div>
          </div>
          <div class="toggle-track on" data-key="archexa.cacheEnabled" id="cacheToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Show token usage after each run</div>
            <div class="toggle-hint">Displays prompt and completion token counts in the result meta line.</div>
          </div>
          <div class="toggle-track" data-key="archexa.showTokenUsage" id="tokenUsageToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>

        <div class="section-label">Editor Integration</div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Show findings as squiggles</div>
            <div class="toggle-hint">Review findings appear as red and yellow underlines in the editor, and in the Problems panel.</div>
          </div>
          <div class="toggle-track on" data-key="archexa.showInlineFindings" id="squigglesToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Auto-review on save</div>
            <div class="toggle-hint">Runs a quick pipeline-mode review every time you save a supported file. Can be noisy on large files.</div>
          </div>
          <div class="toggle-track" data-key="archexa.autoReviewOnSave" id="autoReviewToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-label">Clear findings on new review</div>
            <div class="toggle-hint">Remove previous squiggles before each new review run.</div>
          </div>
          <div class="toggle-track on" data-key="archexa.clearFindingsOnNewReview" id="clearFindingsToggle">
            <div class="toggle-thumb"></div>
          </div>
        </div>

        <div class="section-label">Output</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Output directory</div>
          <input type="text" id="outputDir" data-key="archexa.outputDir" value=".archexa"/>
          <div class="field-hint">Relative to workspace root. Saved markdown results go here.</div>
        </div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Max history entries</div>
          <input type="number" id="maxHistory" data-key="archexa.maxHistory" value="30" min="5" max="200"/>
        </div>

        <div class="settings-save-row">
          <button class="save-btn" data-save="true">Save</button>
        </div>
      </div>

      <!-- ── PROMPTS TAB ── -->
      <div class="settings-tab-content" id="tab-prompts">
        <div class="info-box">
          Custom instructions appended to each command's system prompt. Leave empty for default behaviour. These are appended, not replacing \u2014 Archexa's core logic always runs first. <strong>Supports markdown.</strong>
        </div>

        <div class="prompt-editor" data-prompt="promptQuery">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 1a5 5 0 0 0-3 9v2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-2a5 5 0 0 0-3-9zM6 14h4v1H6z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></span>
            <span class="prompt-editor-name">Explain</span>
            <span class="prompt-badge" id="pi-query-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-query-chars"></span>
            <button class="prompt-expand-btn" data-target="promptQuery">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptQuery-body">
            <textarea class="prompt-area" id="promptQuery" data-key="archexa.promptQuery" placeholder="e.g. Always include the full call chain. Reference every file path with line numbers."></textarea>
            <div class="prompt-editor-footer">
              <span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span>
              <span class="prompt-chars-bottom" id="pi-query-chars-b"></span>
            </div>
          </div>
        </div>

        <div class="prompt-editor" data-prompt="promptReview">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span>
            <span class="prompt-editor-name">Review</span>
            <span class="prompt-badge" id="pi-review-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-review-chars"></span>
            <button class="prompt-expand-btn" data-target="promptReview">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptReview-body">
            <textarea class="prompt-area" id="promptReview" data-key="archexa.promptReview" placeholder="e.g. Focus on security: SQL injection, XSS, auth bypass. Ignore style and formatting issues."></textarea>
            <div class="prompt-editor-footer"><span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span><span class="prompt-chars-bottom" id="pi-review-chars-b"></span></div>
          </div>
        </div>

        <div class="prompt-editor" data-prompt="promptDiagnose">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor"/></svg></span>
            <span class="prompt-editor-name">Diagnose</span>
            <span class="prompt-badge" id="pi-diagnose-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-diagnose-chars"></span>
            <button class="prompt-expand-btn" data-target="promptDiagnose">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptDiagnose-body">
            <textarea class="prompt-area" id="promptDiagnose" data-key="archexa.promptDiagnose" placeholder="e.g. Our logs use structlog JSON format. The app runs on Kubernetes \u2014 check for pod-level issues."></textarea>
            <div class="prompt-editor-footer"><span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span><span class="prompt-chars-bottom" id="pi-diagnose-chars-b"></span></div>
          </div>
        </div>

        <div class="prompt-editor" data-prompt="promptImpact">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><path d="M9 1L4 9h4l-1 6 6-8H9l1-6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></span>
            <span class="prompt-editor-name">Impact</span>
            <span class="prompt-badge" id="pi-impact-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-impact-chars"></span>
            <button class="prompt-expand-btn" data-target="promptImpact">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptImpact-body">
            <textarea class="prompt-area" id="promptImpact" data-key="archexa.promptImpact" placeholder="e.g. We have downstream gRPC consumers \u2014 check proto file compatibility."></textarea>
            <div class="prompt-editor-footer"><span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span><span class="prompt-chars-bottom" id="pi-impact-chars-b"></span></div>
          </div>
        </div>

        <div class="prompt-editor" data-prompt="promptGist">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><path d="M3 1h10v14H3V1z" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="5.5" y1="4" x2="10.5" y2="4" stroke="currentColor" stroke-width="1"/><line x1="5.5" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1"/><line x1="5.5" y1="9" x2="8.5" y2="9" stroke="currentColor" stroke-width="1"/></svg></span>
            <span class="prompt-editor-name">Gist</span>
            <span class="prompt-badge" id="pi-gist-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-gist-chars"></span>
            <button class="prompt-expand-btn" data-target="promptGist">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptGist-body" style="display:none">
            <textarea class="prompt-area" id="promptGist" data-key="archexa.promptGist" placeholder="e.g. Focus on the public API surface."></textarea>
            <div class="prompt-editor-footer"><span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span><span class="prompt-chars-bottom" id="pi-gist-chars-b"></span></div>
          </div>
        </div>

        <div class="prompt-editor" data-prompt="promptAnalyze">
          <div class="prompt-editor-header">
            <span class="prompt-cmd-icon"><svg width="12" height="12" viewBox="0 0 16 16"><rect x="1" y="10" width="3" height="5" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.5" y="6" width="3" height="9" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="12" y="2" width="3" height="13" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></span>
            <span class="prompt-editor-name">Analyze</span>
            <span class="prompt-badge" id="pi-analyze-badge" style="display:none">set</span>
            <span class="prompt-chars" id="pi-analyze-chars"></span>
            <button class="prompt-expand-btn" data-target="promptAnalyze">\u270E Expand editor</button>
          </div>
          <div class="prompt-editor-body" id="promptAnalyze-body" style="display:none">
            <textarea class="prompt-area" id="promptAnalyze" data-key="archexa.promptAnalyze" placeholder="e.g. Include Mermaid diagrams for data flow."></textarea>
            <div class="prompt-editor-footer"><span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported</span><span class="prompt-chars-bottom" id="pi-analyze-chars-b"></span></div>
          </div>
        </div>

        <div class="settings-save-row">
          <button class="save-btn" data-save="true">Save</button>
        </div>
      </div>

      <!-- ── ADVANCED TAB ── -->
      <div class="settings-tab-content" id="tab-advanced">
        <div class="warning-box">Only change these if you are hitting context limit errors or need to reduce API cost. Defaults work for most codebases.</div>

        <div class="section-label">Token Limits</div>
        <div class="grid-2col">
          <div class="grid-field">
            <label>Max prompt tokens</label>
            <input type="number" id="promptBudget" data-key="archexa.promptBudget" value="120000" min="1000"/>
            <div class="field-hint">Total context sent per run.</div>
          </div>
          <div class="grid-field">
            <label>Token reserve</label>
            <input type="number" id="tokenReserve" data-key="archexa.promptReserve" value="16000" min="1000"/>
            <div class="field-hint">Reserved for output.</div>
          </div>
        </div>

        <div class="section-label">Scanning Limits</div>
        <div class="grid-2col">
          <div class="grid-field">
            <label>Max files to scan</label>
            <input type="number" id="maxFiles" data-key="archexa.maxFiles" value="2000" min="10"/>
          </div>
          <div class="grid-field">
            <label>File size limit (bytes)</label>
            <input type="number" id="fileSizeLimit" data-key="archexa.fileSizeLimit" value="300000" min="1000"/>
          </div>
        </div>
        <div class="field" style="margin-top:10px">
          <div class="field-label" style="margin-bottom:4px">Exclusion patterns</div>
          <input type="text" id="excludePatterns" data-key="archexa.excludePatterns" placeholder="e.g. *.test.ts, dist/**, __pycache__/**"/>
          <div class="field-hint">Comma-separated glob patterns. These files are never read by the agent.</div>
        </div>

        <div class="section-label">Agent</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Max deep iterations</div>
          <input type="number" id="deepMaxIterations" data-key="archexa.deepMaxIterations" value="15" min="3" max="30"/>
          <div class="field-hint">Maximum tool-calling rounds per investigation. Higher = more thorough, slower.</div>
        </div>

        <div class="section-label">Logging</div>
        <div class="field">
          <div class="field-label" style="margin-bottom:4px">Log level</div>
          <select id="logLevel" data-key="archexa.logLevel">
            <option value="DEBUG">DEBUG</option>
            <option value="INFO">INFO</option>
            <option value="WARNING" selected>WARNING</option>
            <option value="ERROR">ERROR</option>
          </select>
        </div>

        <div style="padding-top:10px;margin-top:4px;border-top:1px solid var(--vscode-editorGroup-border)">
          <div class="section-label" style="margin-top:0">Binary</div>
          <div class="bin-path" id="binPath">...</div>
          <div class="btn-row">
            <button class="btn-secondary" id="btnVerify">Verify</button>
            <button class="btn-secondary" id="btnCheckUpdate">Update</button>
            <button class="btn-secondary" id="btnRedownload">Re-download</button>
            <button class="btn-secondary" id="btnOpenBin">Open folder</button>
          </div>
        </div>

        <div class="settings-save-row">
          <button class="save-btn" data-save="true">Save</button>
        </div>
      </div>

    </div>
    <div class="save-toast" id="saveToast">\u2713 Saved</div>
  </div>

  <!-- ═══════════════════════════════════════════════════════
       INPUT AREA (always visible on home + chat screens)
       ═══════════════════════════════════════════════════════ -->
  <!-- Prompt full-screen editor modal -->
  <div id="promptModal" class="prompt-modal" style="display:none">
    <div class="prompt-modal-header">
      <button class="prompt-modal-close" id="promptModalClose">\u2190</button>
      <span class="prompt-modal-title" id="promptModalTitle">Edit Prompt</span>
      <span class="prompt-modal-chars" id="promptModalChars"></span>
      <button class="save-btn prompt-modal-save" id="promptModalSave">Save</button>
    </div>
    <div class="prompt-modal-body">
      <textarea class="prompt-modal-textarea" id="promptModalTextarea" placeholder="Enter your custom prompt... Markdown supported."></textarea>
    </div>
    <div class="prompt-modal-footer">
      <span style="color:var(--vscode-descriptionForeground);font-size:9.5px">Markdown supported \u00B7 Escape to close</span>
    </div>
  </div>

  <div class="chat-input-area" id="inputArea">
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
    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("sendBtn");
    const cancelBtnEl = document.getElementById("cancelBtn");
    const slashMenu = document.getElementById("slashMenu");
    const intentBadge = document.getElementById("intentBadge");
    const contextStrip = document.getElementById("contextStrip");
    const inputArea = document.getElementById("inputArea");
    let isStreaming = false;
    let slashIdx = -1;
    let currentIntent = null;
    let currentScreen = "home";

    // ── Screen switching ──
    function showScreen(name) {
      currentScreen = name;
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      const el = document.getElementById("screen-" + name);
      if (el) el.classList.add("active");
      // Input area visible on home + chat, hidden on settings
      inputArea.style.display = (name === "settings") ? "none" : "block";
    }

    // ── SVG codicons (16x16, currentColor, VS Code native style) ──
    const ICONS = {
      explain:  '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 1a5 5 0 0 0-3 9v2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-2a5 5 0 0 0-3-9zM6 14h4v1H6z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
      review:   '<svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
      diagnose: '<svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor"/></svg>',
      impact:   '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M9 1L4 9h4l-1 6 6-8H9l1-6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
      query:    '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M2 2h12v9H6l-4 3V2z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="7" r="0.7" fill="currentColor"/><circle cx="8" cy="7" r="0.7" fill="currentColor"/><circle cx="10.5" cy="7" r="0.7" fill="currentColor"/></svg>',
      gist:     '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 1h10v14H3V1z" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="5.5" y1="4" x2="10.5" y2="4" stroke="currentColor" stroke-width="1"/><line x1="5.5" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1"/><line x1="5.5" y1="9" x2="8.5" y2="9" stroke="currentColor" stroke-width="1"/></svg>',
      analyze:  '<svg width="14" height="14" viewBox="0 0 16 16"><rect x="1" y="10" width="3" height="5" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.5" y="6" width="3" height="9" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="12" y="2" width="3" height="13" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    };

    const CMDS = [
      { id:"explain",  type:"explain",  slash:"/explain",           args:"<fn>",       desc:"Understand any function, file, or pattern",   what:"Plain-English \\u00B7 risks \\u00B7 dependencies" },
      { id:"review",   type:"review",   slash:"/review",            args:"<file>",     desc:"Find bugs, security issues, risky patterns",  what:"Findings first \\u00B7 then explanation \\u00B7 editor squiggles" },
      { id:"review2",  type:"review",   slash:"/review --changed",  args:"",           desc:"Review uncommitted changes",                  what:"Review your git changes" },
      { id:"diagnose", type:"diagnose", slash:"/diagnose",          args:"<error>",    desc:"Trace any error to its root cause",           what:"Call chain first \\u00B7 root cause \\u00B7 fix" },
      { id:"impact",   type:"impact",   slash:"/impact",            args:"<file>",     desc:"What breaks if this changes?",                what:"Trace callers and consumers" },
      { id:"query",    type:"query",    slash:"/query",             args:"<question>", desc:"Ask anything about your codebase",             what:"Deep investigation with citations" },
      { id:"gist",     type:"gist",     slash:"/gist",              args:"",           desc:"Quick codebase overview",                     what:"Fast overview of everything" },
      { id:"analyze",  type:"analyze",  slash:"/analyze",           args:"",           desc:"Full architecture documentation",             what:"Comprehensive architecture doc" },
    ];

    function detectIntent(t) {
      const s = t.toLowerCase();
      if (/\\berror\\b|exception|failing|crash|why is|traceback|not work|decode|typeerror/.test(s)) return { id:"diagnose", label:"Diagnose", icon:ICONS.diagnose };
      if (/\\breview\\b|check|securi|bug|vulnerab|\\bsql\\b|jwt|audit|issues?/.test(s)) return { id:"review", label:"Review", icon:ICONS.review };
      if (/explain|what (does|is)|how does|understand|purpose/.test(s)) return { id:"explain", label:"Explain", icon:ICONS.explain };
      if (/impact|what breaks|what happens if|change|affect/.test(s)) return { id:"impact", label:"Impact", icon:ICONS.impact };
      return null;
    }

    // ── Build home command cards ──
    const PRIMARY = ["explain", "review", "diagnose"];
    const SECONDARY = ["impact", "query", "gist", "analyze"];

    // Primary: full cards with icon, title, description, subtitle
    const primaryHtml = CMDS.filter(c => PRIMARY.includes(c.type) && !c.id.includes("2")).map(c =>
      '<div class="cmd-card" data-slash="' + c.slash + '" data-type="' + c.type + '">'
      + '<div class="cmd-card-icon">' + (ICONS[c.type] || "") + '</div>'
      + '<div class="cmd-card-body">'
      + '<div class="cmd-card-title">' + c.type.charAt(0).toUpperCase() + c.type.slice(1) + '</div>'
      + '<div class="cmd-card-tagline">' + c.desc + '</div>'
      + '<div class="cmd-card-what">' + (c.what || "") + '</div>'
      + '</div></div>'
    ).join("");
    document.getElementById("primaryCards").innerHTML = primaryHtml;

    // Secondary: compact rows — icon + name + description on one line
    const secondaryHtml = CMDS.filter(c => SECONDARY.includes(c.type)).map(c =>
      '<div class="cmd-row" data-slash="' + c.slash + '" data-type="' + c.type + '">'
      + '<span class="cmd-row-icon">' + (ICONS[c.type] || "") + '</span>'
      + '<span class="cmd-row-name">' + c.type.charAt(0).toUpperCase() + c.type.slice(1) + '</span>'
      + '<span class="cmd-row-desc">' + c.desc + '</span>'
      + '</div>'
    ).join("");
    document.getElementById("secondaryCards").innerHTML = secondaryHtml;

    // More toggle
    document.getElementById("moreToggle").addEventListener("click", function() {
      const sec = document.getElementById("secondaryCards");
      const open = sec.style.display !== "none";
      sec.style.display = open ? "none" : "block";
      this.innerHTML = (open ? "\\u25B6" : "\\u25BE") + " More actions";
    });

    // Click handlers for all cards and rows
    document.querySelectorAll(".cmd-card, .cmd-row").forEach(el => {
      el.addEventListener("click", () => {
        const slash = el.dataset.slash;
        chatInput.value = slash + " ";
        chatInput.focus();
        updateSlashMenu();
      });
    });

    // Request editor context
    vscodeApi.postMessage({ type: "getContext" });

    // ── Gear button ──
    document.getElementById("gearBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "showSettings" });
    });

    // ── Home button handlers ──
    document.getElementById("clearHistoryBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "clearHistory" });
    });
    document.getElementById("progressCancelBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "cancelRun" });
    });

    // ── File autocomplete state ──
    let fileCompleteTimer = null;
    let fileMenuIdx = -1;
    const FILE_CMDS = ["/review", "/impact", "/diagnose"];

    function getFilePrefix() {
      const val = chatInput.value;
      for (const cmd of FILE_CMDS) {
        if (val.startsWith(cmd + " ")) {
          const rest = val.slice(cmd.length + 1);
          if (!rest || rest.startsWith("-")) return null;
          // Support comma-separated: get the last segment after comma
          const lastComma = rest.lastIndexOf(",");
          const current = lastComma >= 0 ? rest.slice(lastComma + 1) : rest;
          // Don't trigger if current segment has spaces (it's a description, not a path)
          if (!current || current.includes(" ")) return null;
          return current;
        }
      }
      return null;
    }

    function requestFileComplete(prefix) {
      if (fileCompleteTimer) clearTimeout(fileCompleteTimer);
      fileCompleteTimer = setTimeout(() => {
        vscodeApi.postMessage({ type: "fileComplete", prefix: prefix });
      }, 150);
    }

    // ── Auto-resize textarea ──
    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
      updateSlashMenu();
      updateIntent();
      // File autocomplete
      const fp = getFilePrefix();
      if (fp && fp.length >= 2) {
        requestFileComplete(fp);
      } else {
        if (slashMenu.style.display !== "none" && slashMenu.dataset.mode === "file") {
          slashMenu.style.display = "none";
          slashMenu.dataset.mode = "";
        }
      }
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

    // ── Keyboard ──
    chatInput.addEventListener("keydown", (e) => {
      if (slashMenu.style.display !== "none") {
        const items = slashMenu.querySelectorAll(".slash-item");
        if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = Math.min(slashIdx + 1, items.length - 1); highlightSlash(items); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = Math.max(slashIdx - 1, 0); highlightSlash(items); return; }
        if ((e.key === "Enter" || e.key === "Tab") && items[slashIdx]) {
          e.preventDefault();
          if (slashMenu.dataset.mode === "file") {
            items[slashIdx].click(); // triggers the file click handler
          } else {
            selectSlash(items[slashIdx]);
          }
          return;
        }
        if (e.key === "Escape") { slashMenu.style.display = "none"; return; }
      }
      if (e.key === "Tab" && currentIntent) { e.preventDefault(); sendMessage(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isStreaming && chatInput.value.trim()) sendMessage(); }
    });

    sendBtn.addEventListener("click", () => { if (!isStreaming && chatInput.value.trim()) sendMessage(); });
    cancelBtnEl.addEventListener("click", () => { vscodeApi.postMessage({ type: "cancel" }); });

    // ── Delegated clicks (file links, copy, save, details) ──
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
      // Switch to chat screen on first message
      if (currentScreen === "home") showScreen("chat");
      vscodeApi.postMessage({ type: "send", text: chatInput.value.trim() });
      chatInput.value = "";
      chatInput.style.height = "auto";
      slashMenu.style.display = "none";
      intentBadge.style.display = "none";
    }

    function setStreaming(on) {
      isStreaming = on;
      sendBtn.style.display = on ? "none" : "block";
      cancelBtnEl.style.display = on ? "block" : "none";
      sendBtn.disabled = on;
      chatInput.disabled = on;
      if (!on) chatInput.focus();
    }

    function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

    // ── Agent log parser ──
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
      return null;
    }

    // ── Settings bindings ──
    document.getElementById("btnVerify").addEventListener("click", () => vscodeApi.postMessage({ type: "verifyBinary" }));
    document.getElementById("btnCheckUpdate").addEventListener("click", () => vscodeApi.postMessage({ type: "checkUpdate" }));
    document.getElementById("btnRedownload").addEventListener("click", () => vscodeApi.postMessage({ type: "redownload" }));
    document.getElementById("btnOpenBin").addEventListener("click", () => vscodeApi.postMessage({ type: "openBinFolder" }));
    document.getElementById("btnTestConn").addEventListener("click", () => vscodeApi.postMessage({ type: "testConnection" }));
    document.getElementById("settingsBackBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "goBack" });
    });

    // Tab switching
    document.querySelectorAll(".settings-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        const content = document.getElementById("tab-" + tab.getAttribute("data-tab"));
        if (content) content.classList.add("active");
      });
    });

    // Toggle switches
    document.querySelectorAll(".toggle-track").forEach(track => {
      track.addEventListener("click", () => {
        track.classList.toggle("on");
        const key = track.getAttribute("data-key");
        if (key) {
          vscodeApi.postMessage({ type: "update", key, value: track.classList.contains("on") });
        }
      });
    });

    // Text/password/number inputs + select + textareas
    document.querySelectorAll(".settings-scroll input[data-key], .settings-scroll textarea[data-key], .settings-scroll select[data-key]").forEach(el => {
      const eventName = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, () => {
        const key = el.getAttribute("data-key");
        let val = el.value;
        if (el.type === "number") val = Number(val);
        // For excludePatterns, convert comma-separated string to array
        if (key === "archexa.excludePatterns") {
          val = val.split(",").map(s => s.trim()).filter(Boolean);
        }
        vscodeApi.postMessage({ type: "update", key, value: val });
      });
    });

    // API key show/hide
    document.getElementById("toggleApiKey").addEventListener("click", () => {
      const inp = document.getElementById("apiKey");
      const btn = document.getElementById("toggleApiKey");
      if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
      else { inp.type = "password"; btn.textContent = "Show"; }
    });

    // Prompt full-screen modal
    const promptModal = document.getElementById("promptModal");
    const promptModalTextarea = document.getElementById("promptModalTextarea");
    const promptModalTitle = document.getElementById("promptModalTitle");
    const promptModalChars = document.getElementById("promptModalChars");
    let activePromptId = null;

    function openPromptModal(promptId) {
      const ta = document.getElementById(promptId);
      if (!ta) return;
      activePromptId = promptId;
      const name = promptId.replace("prompt", "");
      promptModalTitle.textContent = name;
      promptModalTextarea.value = ta.value;
      promptModalChars.textContent = ta.value.length > 0 ? ta.value.length + " chars" : "";
      promptModal.style.display = "flex";
      promptModalTextarea.focus();
    }

    function closePromptModal() {
      if (!activePromptId) return;
      const ta = document.getElementById(activePromptId);
      if (ta) {
        ta.value = promptModalTextarea.value;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        updatePromptMeta(ta);
      }
      promptModal.style.display = "none";
      activePromptId = null;
    }

    promptModalTextarea.addEventListener("input", () => {
      promptModalChars.textContent = promptModalTextarea.value.length > 0 ? promptModalTextarea.value.length + " chars" : "";
    });

    document.getElementById("promptModalClose").addEventListener("click", closePromptModal);
    document.getElementById("promptModalSave").addEventListener("click", () => {
      closePromptModal();
      vscodeApi.postMessage({ type: "save" });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && promptModal.style.display !== "none") {
        closePromptModal();
      }
    });

    // Prompt expand buttons → open modal
    document.querySelectorAll(".prompt-expand-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        openPromptModal(btn.dataset.target);
      });
    });

    function updatePromptMeta(ta) {
      const id = ta.id;
      const name = id.replace("prompt", "").toLowerCase();
      const badge = document.getElementById("pi-" + name + "-badge");
      const chars = document.getElementById("pi-" + name + "-chars");
      const charsB = document.getElementById("pi-" + name + "-chars-b");
      const len = ta.value.trim().length;
      if (badge) badge.style.display = len > 0 ? "inline" : "none";
      if (chars) chars.textContent = len > 0 ? len + " chars" : "";
      if (charsB) charsB.textContent = len > 0 ? len + " chars" : "";
    }

    document.querySelectorAll("textarea.prompt-area").forEach(ta => {
      ta.addEventListener("input", () => updatePromptMeta(ta));
    });

    // Save buttons (primary + per-tab)
    document.querySelectorAll(".save-btn, [data-save]").forEach(btn => {
      btn.addEventListener("click", () => {
        vscodeApi.postMessage({ type: "save" });
      });
    });

    // ── Settings config apply ──
    function applyConfig(c) {
      if (c.binaryPath) document.getElementById("binPath").textContent = c.binaryPath;
      if (c.apiKey) document.getElementById("apiKey").value = c.apiKey;
      if (c.model) document.getElementById("settingsModel").value = c.model;
      if (c.endpoint) document.getElementById("settingsEndpoint").value = c.endpoint;

      // Toggles
      setToggle("tlsToggle", c.tlsVerify !== false);
      setToggle("deepToggle", c.deepByDefault !== false);
      setToggle("cacheToggle", c.cacheEnabled !== false);
      setToggle("tokenUsageToggle", c.showTokenUsage === true);
      setToggle("squigglesToggle", c.showInlineFindings !== false);
      setToggle("autoReviewToggle", c.autoReviewOnSave === true);
      setToggle("clearFindingsToggle", c.clearFindingsOnNewReview !== false);

      // Behaviour fields
      if (c.outputDir != null) document.getElementById("outputDir").value = c.outputDir;
      if (c.maxHistory != null) document.getElementById("maxHistory").value = c.maxHistory;

      // Advanced fields
      if (c.promptBudget != null) document.getElementById("promptBudget").value = c.promptBudget;
      if (c.promptReserve != null) document.getElementById("tokenReserve").value = c.promptReserve;
      if (c.maxFiles != null) document.getElementById("maxFiles").value = c.maxFiles;
      if (c.fileSizeLimit != null) document.getElementById("fileSizeLimit").value = c.fileSizeLimit;
      if (c.deepMaxIterations != null) document.getElementById("deepMaxIterations").value = c.deepMaxIterations;
      if (c.logLevel) document.getElementById("logLevel").value = c.logLevel;

      // Exclusion patterns — stored as array, displayed as comma-separated text
      if (Array.isArray(c.excludePatterns)) {
        document.getElementById("excludePatterns").value = c.excludePatterns.join(", ");
      }

      // Custom prompts
      ["Diagnose", "Review", "Query", "Impact", "Gist", "Analyze"].forEach(name => {
        const key = "prompt" + name;
        const el = document.getElementById(key);
        if (el && c[key]) {
          el.value = c[key];
          updatePromptMeta(el);
          // Auto-expand editors that have content
          if (c[key].trim()) {
            const body = document.getElementById(key + "-body");
            const btn = document.querySelector('.prompt-expand-btn[data-target="' + key + '"]');
            if (body) body.style.display = "block";
            if (btn) btn.textContent = "\\u25BC Collapse";
          }
        }
      });
    }

    function setToggle(id, on) {
      const el = document.getElementById(id);
      if (el) { el.classList.toggle("on", on); }
    }

    // ── History rendering ──
    let historyData = [];
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

    // ── Message handler ──
    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        // Screen switching
        case "showScreen":
          showScreen(msg.screen);
          break;

        // Sidebar status + history
        case "update": {
          document.getElementById("statusCard").style.display = "flex";
          const dot = document.getElementById("statusDot");
          const statusText = document.getElementById("statusText");
          if (msg.hasKey) {
            dot.className = "status-dot ok";
            statusText.textContent = msg.workspace ? "Ready \\u2014 " + msg.workspace : "Ready";
          } else {
            dot.className = "status-dot warn";
            statusText.textContent = "No API key configured";
          }
          document.getElementById("modelName").textContent = msg.model;
          document.getElementById("modeBadge").innerHTML = msg.deep
            ? '<span class="cmd-badge deep">DEEP</span>'
            : '<span class="cmd-badge pipeline">PIPELINE</span>';
          document.getElementById("versionLabel").textContent = msg.version ? "v" + msg.version.replace(/^v/, "") : "";
          historyData = msg.history || [];
          renderHistory();
          break;
        }

        // Progress bar (sidebar)
        case "progress": {
          if (msg.id) {
            // Chat progress — update the message meta
            const el = document.getElementById("msg-" + msg.id);
            if (!el) break;
            const status = el.querySelector(".msg-meta-status");
            if (status) status.textContent = "[" + msg.phase + "/" + msg.total + "] " + msg.label + (msg.detail ? " \\u2014 " + msg.detail : "");
          } else {
            // Sidebar progress bar
            const sec = document.getElementById("progressSection");
            sec.style.display = "block";
            document.getElementById("progressLabel").textContent = msg.label;
            document.getElementById("progressFill").style.width = msg.pct + "%";
          }
          break;
        }
        case "progressDone":
          document.getElementById("progressSection").style.display = "none";
          break;

        // Chat progress (from bridge onProgress)
        case "chatProgress": {
          const el = document.getElementById("msg-" + msg.id);
          if (!el) break;
          const status = el.querySelector(".msg-meta-status");
          if (status) status.textContent = "[" + msg.phase + "/" + msg.total + "] " + msg.label + (msg.detail ? " \\u2014 " + msg.detail : "");
          break;
        }

        // Editor context
        case "editorContext": {
          let html = "";
          if (msg.file) {
            html += '<span style="color:var(--vscode-disabledForeground)">Active:</span> ';
            html += '<span style="color:var(--vscode-textLink-foreground);font-family:var(--vscode-editor-font-family)">' + msg.file + '</span>';
          }
          if (msg.selection) {
            html += '<span class="context-sep">\\u00B7</span>';
            html += '<span style="color:var(--vscode-disabledForeground)">Selected:</span> ';
            html += '<span style="color:var(--vscode-editorWarning-foreground);font-family:var(--vscode-editor-font-family)">' + msg.selection + '</span>';
          }
          contextStrip.innerHTML = html || '<span style="color:var(--vscode-disabledForeground)">No file open</span>';
          break;
        }

        // Chat messages
        case "userMessage": {
          // Switch to chat screen if not already
          if (currentScreen !== "chat") showScreen("chat");
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
            + '<div class="skeleton-line" style="width:90%"></div>'
            + '<div class="skeleton-line" style="width:70%;animation-delay:0.1s"></div>'
            + '<div class="skeleton-line" style="width:95%;animation-delay:0.15s"></div>'
            + '<div style="height:6px"></div>'
            + '<div class="skeleton-line" style="width:80%;animation-delay:0.2s"></div>'
            + '<div class="skeleton-line" style="width:60%;animation-delay:0.25s"></div>'
            + '<div class="skeleton-line" style="width:85%;animation-delay:0.3s"></div>'
            + '<div style="height:6px"></div>'
            + '<div class="skeleton-line" style="width:75%;animation-delay:0.35s"></div>'
            + '<div class="skeleton-line" style="width:55%;animation-delay:0.4s"></div>'
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
          const liveEl = document.getElementById("livestep-" + msg.id);
          if (liveEl && msg.line.includes("agent.tool name=")) {
            liveEl.style.display = "flex";
            const m = msg.line.match(/name=(\\S+)\\s+args=\\{['\"]?(\\w+)['\"]?:\\s*['\"]?([^'"}]+)/);
            liveEl.innerHTML = '<span class="live-step-arrow">\\u2192</span><span class="live-step-text">' + (m ? m[1] + "(" + m[3].slice(0,40) + ")" : "working...") + '</span><div class="dot-pulse"><span></span><span></span><span></span></div>';
          }
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
          if (!container.querySelector(".findings-panel")) {
            container.innerHTML = '<div class="findings-panel"><div class="findings-header"><span>Findings</span><span id="fcounts-' + msg.id + '"></span></div><div id="frows-' + msg.id + '"></div></div>';
          }
          const rows = document.getElementById("frows-" + msg.id);
          const isErr = f.severity === "error" || f.severity === "high" || f.severity === "critical";
          rows.innerHTML += '<div class="finding-row"><span class="finding-sev" style="color:' + (isErr?"var(--vscode-errorForeground)":"var(--vscode-editorWarning-foreground)") + '">' + (isErr?"\\u2B24":"\\u25C6") + '</span><div style="flex:1"><div class="finding-msg">' + (f.message||"").replace(/</g,"&lt;") + '</div><div class="finding-loc"><span class="finding-file file-link" data-file="' + f.file + '" data-line="' + f.line + '">' + f.file + ':' + f.line + '</span>' + (f.rule?'<span class="finding-rule">'+f.rule+'</span>':'') + '</div></div></div>';
          scrollToBottom();
          break;
        }

        case "assistantChunk": {
          const skel = document.getElementById("skeleton-" + msg.id);
          if (skel) skel.style.display = "none";
          const content = document.getElementById("content-" + msg.id);
          if (content) { content.style.display = "block"; content.innerHTML = msg.html; }
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
          const status = el.querySelector(".msg-meta-status");
          if (status) {
            status.style.animation = "none";
            status.style.color = "var(--vscode-terminal-ansiGreen)";
            status.textContent = "\\u2713 Done" + (msg.durationMs > 0 ? " \\u00B7 " + (msg.durationMs/1000).toFixed(1) + "s" : "");
          }
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

        case "fileCompleteResults": {
          const files = msg.files || [];
          if (!files.length) { if (slashMenu.dataset.mode === "file") { slashMenu.style.display = "none"; slashMenu.dataset.mode = ""; } break; }
          slashMenu.dataset.mode = "file";
          fileMenuIdx = 0;
          slashMenu.innerHTML = files.map((f, i) => {
            const parts = f.split("/");
            const name = parts.pop();
            const dir = parts.join("/");
            return '<div class="slash-item' + (i === 0 ? ' active' : '') + '" data-filepath="' + f + '">'
              + '<span class="slash-icon" style="font-size:11px;opacity:0.5">\\u{1F4C4}</span>'
              + '<span class="slash-cmd" style="font-weight:400">' + name + '</span>'
              + (dir ? '<span class="slash-desc" style="font-family:var(--vscode-editor-font-family)">' + dir + '/</span>' : '')
              + '</div>';
          }).join("");
          slashMenu.style.display = "block";
          slashMenu.querySelectorAll(".slash-item").forEach(el => {
            el.addEventListener("click", () => {
              const fp = el.dataset.filepath;
              const val = chatInput.value;
              for (const cmd of FILE_CMDS) {
                if (val.startsWith(cmd + " ")) {
                  const rest = val.slice(cmd.length + 1);
                  const lastComma = rest.lastIndexOf(",");
                  if (lastComma >= 0) {
                    // Multi-file: replace only the part after the last comma
                    chatInput.value = cmd + " " + rest.slice(0, lastComma + 1) + fp;
                  } else {
                    chatInput.value = cmd + " " + fp;
                  }
                  break;
                }
              }
              slashMenu.style.display = "none";
              slashMenu.dataset.mode = "";
              chatInput.focus();
            });
          });
          break;
        }

        // Settings
        case "init":
          applyConfig(msg.config);
          break;
        case "saveConfirmed": {
          const toast = document.getElementById("saveToast");
          // Flash all save buttons on current tab
          document.querySelectorAll(".save-btn").forEach(btn => {
            btn.textContent = "\\u2713";
            btn.classList.add("saved");
          });
          toast.style.display = "block";
          setTimeout(() => {
            toast.style.display = "none";
            document.querySelectorAll(".save-btn").forEach(btn => {
              btn.textContent = "Save";
              btn.classList.remove("saved");
            });
          }, 1800);
          break;
        }
        case "connResult": {
          const el = document.getElementById("connStatus");
          const badge = document.getElementById("connBadge");
          el.style.display = "block";
          if (msg.pending) {
            el.style.background = "var(--vscode-editor-lineHighlightBackground)";
            el.style.color = "var(--vscode-editor-foreground)";
            el.innerHTML = "\\u27F3 " + msg.message;
            badge.style.display = "none";
          } else if (msg.ok) {
            el.style.background = "var(--vscode-terminal-ansiGreen, #4ec966)";
            el.style.color = "#000";
            el.innerHTML = "\\u25CF " + msg.message;
            // Show persistent badge in header
            badge.style.display = "inline";
            badge.style.background = "rgba(63,185,80,0.15)";
            badge.style.color = "var(--vscode-terminal-ansiGreen, #4ec966)";
            badge.textContent = "\\u25CF Connected";
            // Auto-hide the green card after 4s
            setTimeout(() => { el.style.display = "none"; }, 4000);
          } else {
            el.style.background = "var(--vscode-inputValidation-errorBackground, #5a1d1d)";
            el.style.color = "var(--vscode-errorForeground, #f44747)";
            el.innerHTML = "\\u2717 " + msg.message;
            badge.style.display = "inline";
            badge.style.background = "rgba(248,81,73,0.15)";
            badge.style.color = "var(--vscode-errorForeground, #f44747)";
            badge.textContent = "\\u2717 Failed";
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
