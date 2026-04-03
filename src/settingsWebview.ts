import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { generateConfigYaml } from "./utils/config.js";
import { getNonce } from "./utils/platform.js";

export class SettingsWebview {
  private panel: vscode.WebviewPanel | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private scheduleSyncConfigFile(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.syncConfigFile(), 1000);
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "archexa.settings",
      "Archexa Settings",
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
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "settings.css")
    );

    this.panel.webview.html = this.getHtml(cssUri, getNonce());
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Send initial config
    this.sendConfig();

    // Refresh config when panel regains focus (e.g. after binary update)
    this.panel.onDidChangeViewState(() => {
      if (this.panel?.visible) {
        this.sendConfig();
      }
    });

    // Refresh when settings change externally
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("archexa")) {
        this.sendConfig();
      }
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this.handleMessage(msg),
      undefined,
      this.ctx.subscriptions
    );
  }

  private sendConfig(): void {
    const cfg = vscode.workspace.getConfiguration("archexa");
    const config: Record<string, unknown> = {};
    const props = [
      "apiKey", "model", "endpoint", "binaryPath", "binaryVersion",
      "deepByDefault", "deepMaxIterations", "cacheEnabled",
      "showInlineFindings", "autoReviewOnSave", "outputDir",
      "promptBudget", "promptReserve", "maxFiles", "fileSizeLimit", "maxHistory",
      "logLevel", "tlsVerify",
      "promptDiagnose", "promptReview", "promptQuery", "promptImpact", "promptGist", "promptAnalyze",
      "excludePatterns", "scanFocus", "reviewTarget",
    ];
    for (const prop of props) {
      config[prop] = cfg.get(prop);
    }
    this.panel?.webview.postMessage({ type: "init", config });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "update": {
        const key = msg.key as string;
        const value = msg.value;
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
        // Debounce config file sync (don't write on every keystroke)
        this.scheduleSyncConfigFile();
        break;
      }
      case "save":
        this.syncConfigFile();
        this.panel?.webview.postMessage({ type: "saveConfirmed" });
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
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(dir)
          );
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

  /**
   * Write current VS Code settings to archexa.yaml in the workspace root.
   * This keeps the config file in sync so the CLI reads the correct values.
   */
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
      // Send a real chat completion request — this verifies endpoint + API key + model all work
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
    this.panel?.webview.postMessage({ type: "connResult", ok, message, pending });
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

  private getHtml(_cssUri: vscode.Uri, nonce?: string): string {
    const n = nonce ?? getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel!.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${this.panel!.webview.cspSource} data:;" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Top bar ── */
    .top-bar {
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      padding: 0 14px;
      height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .top-bar .back-btn {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 12px;
      padding: 0;
    }
    .top-bar .back-btn:hover { color: var(--vscode-editor-foreground); }
    .top-bar .sep { color: var(--vscode-disabledForeground); }
    .top-bar .title { color: var(--vscode-editor-foreground); font-size: 12.5px; font-weight: 600; }
    .top-bar .spacer { flex: 1; }
    .top-bar .version-badge {
      color: var(--vscode-terminal-ansiGreen, #3fb950);
      font-size: 10px;
      background: rgba(63,185,80,.1);
      border: 1px solid rgba(63,185,80,.2);
      border-radius: 10px;
      padding: 0 7px;
      line-height: 18px;
    }
    .top-bar .yaml-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 5px;
      padding: 4px 12px;
      font-size: 11px;
      cursor: pointer;
    }
    .top-bar .yaml-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .top-bar .save-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 5px;
      padding: 4px 16px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      min-width: 58px;
      transition: background .2s;
    }
    .top-bar .save-btn:hover { background: var(--vscode-button-hoverBackground); }
    .top-bar .save-btn.saved { background: var(--vscode-terminal-ansiGreen, #3fb950); }

    /* ── Content scroll area ── */
    .content-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      gap: 0;
    }
    .content-main { flex: 1; min-width: 0; }

    /* ── Section label ── */
    .section-label {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 9px;
    }

    /* ── Fields ── */
    .field { margin-bottom: 10px; }
    .field-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .field-label { color: var(--vscode-editor-foreground); font-size: 12px; }
    .field-required { color: var(--vscode-errorForeground); font-size: 10px; }
    .field-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      margin-top: 3px;
    }

    input[type="text"],
    input[type="password"],
    input[type="number"] {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 5px;
      padding: 7px 9px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11.5px;
      outline: none;
      transition: border-color .12s;
    }
    input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    input.has-value { border-color: var(--vscode-textLink-foreground); }

    .input-row {
      display: flex;
      gap: 6px;
    }
    .input-row input { flex: 1; }

    .show-hide-btn {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 5px;
      padding: 7px 10px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .show-hide-btn:hover { color: var(--vscode-editor-foreground); }

    /* ── Preset chips ── */
    .chip-row {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      margin-bottom: 5px;
    }
    .chip {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
      transition: all .12s;
      user-select: none;
    }
    .chip:hover {
      border-color: var(--vscode-textLink-foreground);
      color: var(--vscode-textLink-foreground);
    }
    .chip.active {
      background: rgba(56,139,253,.13);
      border-color: var(--vscode-textLink-foreground);
      color: var(--vscode-textLink-foreground);
    }
    .chip-model {
      font-family: var(--vscode-editor-font-family);
      font-size: 10.5px;
    }

    /* ── Test connection ── */
    .btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 5px;
      padding: 5px 14px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-editorGroup-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      padding: 3px 9px;
      font-size: 10.5px;
      cursor: pointer;
    }
    .btn-secondary:hover { background: var(--vscode-list-hoverBackground); }

    #connStatus {
      margin-top: 8px;
      font-size: 11px;
      padding: 8px 12px;
      border-radius: 5px;
      display: none;
    }

    /* ── Accordion ── */
    .accordion {
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 7px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .accordion-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 13px;
      cursor: pointer;
      background: var(--vscode-sideBar-background);
      user-select: none;
      transition: background .1s;
    }
    .accordion-header:hover { background: var(--vscode-list-hoverBackground); }
    .accordion-header.open { background: var(--vscode-sideBar-background); }
    .accordion-icon { font-size: 14px; flex-shrink: 0; }
    .accordion-title { color: var(--vscode-editor-foreground); font-size: 12.5px; font-weight: 600; flex: 1; }
    .accordion-arrow {
      color: var(--vscode-disabledForeground);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
    }
    .accordion-body {
      padding: 10px 13px;
      background: var(--vscode-editor-background);
      display: none;
    }
    .accordion-body.open { display: block; }

    /* ── Toggle switch (matching mock) ── */
    .toggle-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid rgba(48,54,61,.1);
    }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-info { padding-right: 16px; }
    .toggle-label { color: var(--vscode-editor-foreground); font-size: 12px; }
    .toggle-hint { color: var(--vscode-descriptionForeground); font-size: 10.5px; margin-top: 2px; line-height: 1.4; }
    .toggle-track {
      width: 32px;
      height: 17px;
      border-radius: 9px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-editorGroup-border);
      cursor: pointer;
      position: relative;
      transition: all .18s;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .toggle-track.on {
      background: var(--vscode-textLink-foreground);
      border-color: var(--vscode-textLink-foreground);
    }
    .toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      transition: left .18s;
    }
    .toggle-track.on .toggle-thumb {
      left: 17px;
      background: #fff;
    }

    /* ── Prompt textareas ── */
    .prompt-field { margin-bottom: 9px; }
    .prompt-label { color: var(--vscode-editor-foreground); font-size: 11.5px; margin-bottom: 3px; }
    textarea.prompt-area {
      width: 100%;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 4px;
      color: var(--vscode-terminal-ansiGreen, #3fb950);
      font-size: 11px;
      padding: 5px 9px;
      outline: none;
      font-family: var(--vscode-editor-font-family);
      resize: vertical;
      line-height: 1.5;
    }

    /* ── Warning box ── */
    .warning-box {
      color: var(--vscode-editorWarning-foreground, #d29922);
      font-size: 10.5px;
      background: rgba(210,153,34,.06);
      border: 1px solid rgba(210,153,34,.16);
      border-radius: 4px;
      padding: 5px 9px;
      margin-bottom: 10px;
      line-height: 1.5;
    }

    /* ── Advanced number rows ── */
    .number-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid rgba(48,54,61,.1);
    }
    .number-row:last-of-type { border-bottom: none; }
    .number-row label { color: var(--vscode-editor-foreground); font-size: 11.5px; }
    .number-row input[type="number"] {
      width: 88px;
      text-align: right;
      padding: 3px 7px;
      font-size: 11px;
    }

    /* ── Binary path ── */
    .bin-path {
      color: var(--vscode-terminal-ansiGreen, #3fb950);
      font-size: 10px;
      font-family: var(--vscode-editor-font-family);
      opacity: .7;
      word-break: break-all;
      margin-bottom: 6px;
    }

    /* ── Tag inputs ── */
    .tag-container {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorGroup-border));
      border-radius: 5px;
      padding: 4px 6px;
      min-height: 32px;
    }
    .tag-container:focus-within { border-color: var(--vscode-focusBorder); }
    .tag {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 10.5px;
      font-family: var(--vscode-editor-font-family);
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .tag-remove {
      cursor: pointer;
      opacity: .6;
      font-size: 11px;
    }
    .tag-remove:hover { opacity: 1; }
    .tag-input {
      border: none !important;
      background: transparent !important;
      outline: none !important;
      font-size: 11px;
      color: var(--vscode-input-foreground);
      flex: 1;
      min-width: 80px;
      padding: 2px 4px !important;
    }

    /* ── YAML panel ── */
    .yaml-panel {
      width: 320px;
      background: var(--vscode-textCodeBlock-background);
      border-left: 1px solid var(--vscode-editorGroup-border);
      padding: 12px;
      overflow-y: auto;
      flex-shrink: 0;
      display: none;
    }
    .yaml-panel.visible { display: block; }
    .yaml-title {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: .6px;
      margin-bottom: 8px;
    }
    .yaml-panel pre {
      font-family: var(--vscode-editor-font-family);
      font-size: 10.5px;
      white-space: pre-wrap;
      color: var(--vscode-terminal-ansiGreen, #3fb950);
      line-height: 1.6;
    }

    /* ── Save toast ── */
    .save-toast {
      display: none;
      position: fixed;
      bottom: 16px;
      right: 16px;
      background: var(--vscode-terminal-ansiGreen, #3fb950);
      color: #000;
      padding: 6px 16px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      z-index: 100;
    }

    /* ── Prompt indicators ── */
    .prompt-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 5px;
      vertical-align: middle;
    }
    .prompt-indicator.unset { background: var(--vscode-editorGroup-border); }
    .prompt-indicator.set { background: var(--vscode-terminal-ansiGreen, #3fb950); }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 2px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
  </style>
</head>
<body>

  <!-- Top bar -->
  <div class="top-bar">
    <button class="back-btn" id="backBtn">\u2190 Back</button>
    <span class="sep">\u00B7</span>
    <span class="title">Settings</span>
    <span class="spacer"></span>
    <span class="version-badge" id="versionBadge">\u25CF v...</span>
    <button class="yaml-btn" id="yamlToggle">YAML</button>
    <button class="save-btn" id="saveBtn">Save</button>
  </div>

  <div class="content-scroll">
    <div class="content-main">

      <!-- ═══ CONNECT — always visible ═══ -->
      <div style="margin-bottom:14px">
        <div class="section-label">Connect</div>

        <!-- API Key -->
        <div class="field">
          <div class="field-row">
            <span class="field-label">API Key</span>
            <span class="field-required">required</span>
          </div>
          <div class="input-row">
            <input type="password" id="apiKey" data-key="archexa.apiKey" placeholder="sk-... or set OPENAI_API_KEY env var"/>
            <button class="show-hide-btn" id="toggleApiKey">Show</button>
          </div>
          <div class="field-hint">Leave empty to use OPENAI_API_KEY environment variable</div>
        </div>

        <!-- Endpoint -->
        <div class="field">
          <div class="field-label" style="margin-bottom:5px">Endpoint</div>
          <div class="chip-row" id="endpointChips">
            <div class="chip" data-url="https://api.openai.com/v1/">OpenAI</div>
            <div class="chip" data-url="https://openrouter.ai/api/v1/">OpenRouter</div>
            <div class="chip" data-url="http://localhost:11434/v1/">Ollama</div>
            <div class="chip" data-url="http://localhost:8000/v1/">vLLM</div>
          </div>
          <input type="text" id="endpoint" data-key="archexa.endpoint" placeholder="https://api.openai.com/v1/" style="font-size:11px"/>
        </div>

        <!-- Model -->
        <div class="field">
          <div class="field-label" style="margin-bottom:5px">Model</div>
          <div class="chip-row" id="modelChips">
            <div class="chip chip-model" data-model="gpt-4o">gpt-4o</div>
            <div class="chip chip-model" data-model="gpt-4o-mini">gpt-4o-mini</div>
            <div class="chip chip-model" data-model="claude-sonnet-4-20250514">claude-sonnet-4-20250514</div>
            <div class="chip chip-model" data-model="llama3.1">llama3.1</div>
          </div>
          <input type="text" id="model" data-key="archexa.model" placeholder="gpt-4o" style="font-size:11px"/>
        </div>

        <!-- Test connection -->
        <div class="btn-row">
          <button class="btn-primary" id="btnTestConn">\u25B6 Test Connection</button>
        </div>
        <div id="connStatus"></div>
      </div>

      <!-- ═══ BEHAVIOUR accordion ═══ -->
      <div class="accordion">
        <div class="accordion-header" data-accordion="behaviour">
          <span class="accordion-icon">\u2699\uFE0F</span>
          <span class="accordion-title">Behaviour</span>
          <span class="accordion-arrow">\u25B8</span>
        </div>
        <div class="accordion-body" id="acc-behaviour">
          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-label">Deep mode by default</div>
              <div class="toggle-hint">Agent reads files and traces calls. More accurate, slower.</div>
            </div>
            <div class="toggle-track on" data-key="archexa.deepByDefault" id="deepToggle">
              <div class="toggle-thumb"></div>
            </div>
          </div>
          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-label">Show findings as squiggles</div>
              <div class="toggle-hint">Review findings appear in the editor and Problems panel.</div>
            </div>
            <div class="toggle-track on" data-key="archexa.showInlineFindings" id="squigglesToggle">
              <div class="toggle-thumb"></div>
            </div>
          </div>
          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-label">Auto-review on save</div>
              <div class="toggle-hint">Runs a quick review every time you save a supported file.</div>
            </div>
            <div class="toggle-track" data-key="archexa.autoReviewOnSave" id="autoReviewToggle">
              <div class="toggle-thumb"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ CUSTOM PROMPTS accordion ═══ -->
      <div class="accordion">
        <div class="accordion-header" data-accordion="prompts">
          <span class="accordion-icon">\u270F\uFE0F</span>
          <span class="accordion-title">Custom Prompts</span>
          <span class="accordion-arrow">\u25B8</span>
        </div>
        <div class="accordion-body" id="acc-prompts">
          <div class="field-hint" style="margin-bottom:10px;line-height:1.5">Appended to each command's system prompt. Leave empty for defaults.</div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-diagnose"></span>Diagnose</div>
            <textarea class="prompt-area" rows="2" id="promptDiagnose" data-key="archexa.promptDiagnose" placeholder="e.g. Our logs use structlog JSON. App runs on Kubernetes."></textarea>
          </div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-review"></span>Review</div>
            <textarea class="prompt-area" rows="2" id="promptReview" data-key="archexa.promptReview" placeholder="e.g. Focus on security. Ignore style and formatting issues."></textarea>
          </div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-query"></span>Explain</div>
            <textarea class="prompt-area" rows="2" id="promptQuery" data-key="archexa.promptQuery" placeholder="e.g. Include file paths and line numbers for every function."></textarea>
          </div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-impact"></span>Impact</div>
            <textarea class="prompt-area" rows="2" id="promptImpact" data-key="archexa.promptImpact" placeholder="e.g. Check gRPC proto compatibility with downstream consumers."></textarea>
          </div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-gist"></span>Gist</div>
            <textarea class="prompt-area" rows="2" id="promptGist" data-key="archexa.promptGist" placeholder="e.g. Focus on the public API surface and deployment architecture."></textarea>
          </div>
          <div class="prompt-field">
            <div class="prompt-label"><span class="prompt-indicator unset" id="pi-analyze"></span>Analyze (All)</div>
            <textarea class="prompt-area" rows="2" id="promptAnalyze" data-key="archexa.promptAnalyze" placeholder="e.g. Include Mermaid diagrams for data flow. Focus on microservices."></textarea>
          </div>
        </div>
      </div>

      <!-- ═══ ADVANCED accordion ═══ -->
      <div class="accordion">
        <div class="accordion-header" data-accordion="advanced">
          <span class="accordion-icon">\uD83D\uDD27</span>
          <span class="accordion-title">Advanced</span>
          <span class="accordion-arrow">\u25B8</span>
        </div>
        <div class="accordion-body" id="acc-advanced">
          <div class="warning-box">Only change these if hitting context errors or need to reduce API cost.</div>

          <div class="number-row">
            <label>Max prompt tokens</label>
            <input type="number" id="promptBudget" data-key="archexa.promptBudget" value="120000" min="1000"/>
          </div>
          <div class="number-row">
            <label>Token reserve</label>
            <input type="number" id="tokenReserve" data-key="archexa.promptReserve" value="16000" min="1000"/>
          </div>
          <div class="number-row">
            <label>Max files to scan</label>
            <input type="number" id="maxFiles" data-key="archexa.maxFiles" value="100" min="10"/>
          </div>

          <!-- Scanning: tags -->
          <div style="margin-top:10px">
            <div class="field-label" style="margin-bottom:4px">Scan focus (directories)</div>
            <div class="tag-container" id="scanFocusTags">
              <input type="text" class="tag-input" id="scanFocusInput" placeholder="e.g. src/api/ \u2014 Enter to add"/>
            </div>
            <div class="field-hint" style="margin-bottom:8px">Limit scanning to these directory prefixes.</div>
          </div>
          <div style="margin-bottom:10px">
            <div class="field-label" style="margin-bottom:4px">Exclusion patterns</div>
            <div class="tag-container" id="excludeTags">
              <input type="text" class="tag-input" id="excludeInput" placeholder="e.g. *.test.ts \u2014 Enter to add"/>
            </div>
            <div class="field-hint">Glob patterns for files to skip. node_modules, .git already excluded.</div>
          </div>

          <!-- Binary -->
          <div style="padding-top:10px;margin-top:4px;border-top:1px solid var(--vscode-editorGroup-border)">
            <div class="field-label" style="margin-bottom:5px">Binary</div>
            <div class="bin-path" id="binPath">...</div>
            <div class="btn-row">
              <button class="btn-secondary" id="btnVerify">Verify</button>
              <button class="btn-secondary" id="btnCheckUpdate">Update</button>
              <button class="btn-secondary" id="btnRedownload">Re-download</button>
              <button class="btn-secondary" id="btnOpenBin">Open folder</button>
            </div>
          </div>
        </div>
      </div>

    </div><!-- /content-main -->

    <!-- YAML Panel -->
    <div class="yaml-panel" id="yamlPanel">
      <div class="yaml-title">archexa.yaml preview</div>
      <pre id="yamlPreview"></pre>
    </div>
  </div>

  <div class="save-toast" id="saveToast">\u2713 Saved</div>

  <script nonce="${n}">
    const vscodeApi = acquireVsCodeApi();
    let currentConfig = {};

    function post(type) { vscodeApi.postMessage({ type }); }

    // ── Button bindings ──
    document.getElementById("btnVerify").addEventListener("click", () => post("verifyBinary"));
    document.getElementById("btnCheckUpdate").addEventListener("click", () => post("checkUpdate"));
    document.getElementById("btnRedownload").addEventListener("click", () => post("redownload"));
    document.getElementById("btnOpenBin").addEventListener("click", () => post("openBinFolder"));
    document.getElementById("btnTestConn").addEventListener("click", () => post("testConnection"));
    document.getElementById("backBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "navigateBack" });
    });

    // ── Accordion toggle ──
    document.querySelectorAll(".accordion-header").forEach(header => {
      header.addEventListener("click", () => {
        const id = header.getAttribute("data-accordion");
        const body = document.getElementById("acc-" + id);
        const arrow = header.querySelector(".accordion-arrow");
        const isOpen = body.classList.contains("open");
        body.classList.toggle("open");
        header.classList.toggle("open");
        arrow.textContent = isOpen ? "\u25B8" : "\u25BE";
      });
    });

    // ── Toggle switches ──
    document.querySelectorAll(".toggle-track").forEach(track => {
      track.addEventListener("click", () => {
        track.classList.toggle("on");
        const key = track.getAttribute("data-key");
        if (key) {
          vscodeApi.postMessage({ type: "update", key, value: track.classList.contains("on") });
        }
        updateYaml();
      });
    });

    // ── Text/password/number inputs ──
    document.querySelectorAll("input[data-key], textarea[data-key]").forEach(el => {
      el.addEventListener("input", () => {
        const key = el.getAttribute("data-key");
        let val = el.value;
        if (el.type === "number") val = Number(val);
        vscodeApi.postMessage({ type: "update", key, value: val });
        updateYaml();
      });
    });

    // ── Endpoint chips ──
    document.querySelectorAll("#endpointChips .chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const url = chip.getAttribute("data-url");
        const input = document.getElementById("endpoint");
        input.value = url;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        syncEndpointChips();
      });
    });

    function syncEndpointChips() {
      const val = document.getElementById("endpoint").value;
      document.querySelectorAll("#endpointChips .chip").forEach(c => {
        c.classList.toggle("active", c.getAttribute("data-url") === val);
      });
    }
    document.getElementById("endpoint").addEventListener("input", syncEndpointChips);

    // ── Model chips ──
    document.querySelectorAll("#modelChips .chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const m = chip.getAttribute("data-model");
        const input = document.getElementById("model");
        input.value = m;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        syncModelChips();
      });
    });

    function syncModelChips() {
      const val = document.getElementById("model").value;
      document.querySelectorAll("#modelChips .chip").forEach(c => {
        c.classList.toggle("active", c.getAttribute("data-model") === val);
      });
    }
    document.getElementById("model").addEventListener("input", syncModelChips);

    // ── API key show/hide ──
    document.getElementById("toggleApiKey").addEventListener("click", () => {
      const inp = document.getElementById("apiKey");
      const btn = document.getElementById("toggleApiKey");
      if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
      else { inp.type = "password"; btn.textContent = "Show"; }
    });

    // ── Tag inputs ──
    const TAG_SETTINGS = {
      "excludeTags": "archexa.excludePatterns",
      "scanFocusTags": "archexa.scanFocus",
    };

    function collectTags(containerId) {
      const tags = [];
      document.getElementById(containerId).querySelectorAll(".tag").forEach(t => {
        const text = t.childNodes[0]?.textContent?.trim();
        if (text) tags.push(text);
      });
      return tags;
    }

    function syncTagSetting(containerId) {
      const key = TAG_SETTINGS[containerId];
      if (key) {
        vscodeApi.postMessage({ type: "update", key, value: collectTags(containerId) });
        updateYaml();
      }
    }

    function wireTagInput(inputId, containerId) {
      document.getElementById(inputId).addEventListener("keydown", function(e) {
        if (e.key === "Enter" && this.value.trim()) {
          e.preventDefault();
          addTag(containerId, inputId, this.value.trim());
          this.value = "";
          syncTagSetting(containerId);
        }
      });
    }
    wireTagInput("excludeInput", "excludeTags");
    wireTagInput("scanFocusInput", "scanFocusTags");

    function addTag(containerId, inputId, text) {
      const container = document.getElementById(containerId);
      const input = document.getElementById(inputId);
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = text + " ";
      const removeBtn = document.createElement("span");
      removeBtn.className = "tag-remove";
      removeBtn.textContent = "\u00D7";
      removeBtn.addEventListener("click", () => {
        tag.remove();
        syncTagSetting(containerId);
      });
      tag.appendChild(removeBtn);
      container.insertBefore(tag, input);
    }

    // ── Prompt indicators ──
    document.querySelectorAll("textarea.prompt-area").forEach(ta => {
      ta.addEventListener("input", () => {
        const name = ta.id.replace("prompt", "").toLowerCase();
        const indicator = document.getElementById("pi-" + name);
        if (indicator) {
          indicator.classList.toggle("set", ta.value.trim().length > 0);
          indicator.classList.toggle("unset", ta.value.trim().length === 0);
        }
        updateYaml();
      });
    });

    // ── YAML toggle ──
    document.getElementById("yamlToggle").addEventListener("click", () => {
      const panel = document.getElementById("yamlPanel");
      panel.classList.toggle("visible");
      updateYaml();
    });

    // ── Save button ──
    document.getElementById("saveBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "save" });
    });

    // ── Receive messages ──
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "init") {
        currentConfig = msg.config;
        applyConfig(msg.config);
      } else if (msg.type === "saveConfirmed") {
        const toast = document.getElementById("saveToast");
        const btn = document.getElementById("saveBtn");
        btn.textContent = "\u2713";
        btn.classList.add("saved");
        toast.style.display = "block";
        setTimeout(() => {
          toast.style.display = "none";
          btn.textContent = "Save";
          btn.classList.remove("saved");
        }, 1800);
      } else if (msg.type === "connResult") {
        const el = document.getElementById("connStatus");
        el.style.display = "block";
        if (msg.pending) {
          el.style.background = "var(--vscode-editor-lineHighlightBackground)";
          el.style.color = "var(--vscode-editor-foreground)";
          el.innerHTML = "\u27F3 " + msg.message;
        } else if (msg.ok) {
          el.style.background = "var(--vscode-terminal-ansiGreen, #4ec966)";
          el.style.color = "#000";
          el.innerHTML = "\u25CF " + msg.message;
        } else {
          el.style.background = "var(--vscode-inputValidation-errorBackground, #5a1d1d)";
          el.style.color = "var(--vscode-errorForeground, #f44747)";
          el.innerHTML = "\u2717 " + msg.message;
        }
      }
    });

    function applyConfig(c) {
      if (c.binaryPath) document.getElementById("binPath").textContent = c.binaryPath;
      if (c.binaryVersion) {
        document.getElementById("versionBadge").textContent = "\u25CF v" + c.binaryVersion;
      }
      if (c.apiKey) document.getElementById("apiKey").value = c.apiKey;
      if (c.model) {
        document.getElementById("model").value = c.model;
        syncModelChips();
      }
      if (c.endpoint) {
        document.getElementById("endpoint").value = c.endpoint;
        syncEndpointChips();
      }

      setToggle("deepToggle", c.deepByDefault !== false);
      setToggle("squigglesToggle", c.showInlineFindings !== false);
      setToggle("autoReviewToggle", c.autoReviewOnSave === true);

      // Advanced numeric fields
      if (c.promptBudget != null) document.getElementById("promptBudget").value = c.promptBudget;
      if (c.promptReserve != null) document.getElementById("tokenReserve").value = c.promptReserve;
      if (c.maxFiles != null) document.getElementById("maxFiles").value = c.maxFiles;

      ["Diagnose", "Review", "Query", "Impact", "Gist", "Analyze"].forEach(name => {
        const key = "prompt" + name;
        const el = document.getElementById(key);
        if (el && c[key]) {
          el.value = c[key];
          const indicator = document.getElementById("pi-" + name.toLowerCase());
          if (indicator && c[key].trim()) {
            indicator.classList.add("set");
            indicator.classList.remove("unset");
          }
        }
      });

      // Tag-based fields
      function loadTags(containerId, inputId, values) {
        if (!Array.isArray(values)) return;
        const container = document.getElementById(containerId);
        container.querySelectorAll(".tag").forEach(t => t.remove());
        values.forEach(v => { if (v) addTag(containerId, inputId, v); });
      }
      loadTags("scanFocusTags", "scanFocusInput", c.scanFocus || []);
      loadTags("excludeTags", "excludeInput", c.excludePatterns || []);

      updateYaml();
    }

    function setToggle(id, on) {
      const el = document.getElementById(id);
      if (el) { el.classList.toggle("on", on); }
    }

    function updateYaml() {
      const pre = document.getElementById("yamlPreview");
      if (!pre) return;
      const model = document.getElementById("model")?.value || "gpt-4o";
      const endpoint = document.getElementById("endpoint")?.value || "https://api.openai.com/v1/";
      const deep = document.getElementById("deepToggle")?.classList.contains("on") ?? true;
      const budget = document.getElementById("promptBudget")?.value || "120000";

      let yaml = "archexa:\\n";
      yaml += '  source: "."\\n';
      yaml += "  openai:\\n";
      yaml += '    model: "' + model + '"\\n';
      yaml += '    endpoint: "' + endpoint + '"\\n';
      yaml += "  deep:\\n";
      yaml += "    enabled: " + deep + "\\n";
      yaml += "  limits:\\n";
      yaml += "    prompt_budget: " + budget + "\\n";

      // Prompts
      const prompts = {};
      ["Diagnose", "Review", "Query", "Impact", "Gist", "Analyze"].forEach(name => {
        const el = document.getElementById("prompt" + name);
        if (el && el.value.trim()) prompts[name.toLowerCase()] = el.value.trim();
      });
      if (Object.keys(prompts).length > 0) {
        yaml += "  prompts:\\n";
        for (const [k, v] of Object.entries(prompts)) {
          const cliKey = k === "analyze" ? "user" : k;
          yaml += "    " + cliKey + ": |\\n      " + v.replace(/\\n/g, "\\n      ") + "\\n";
        }
      }

      // Scan focus
      const focusTags = collectTags("scanFocusTags");
      if (focusTags.length > 0) {
        yaml += "  scan_focus:\\n";
        focusTags.forEach(t => { yaml += '    - "' + t + '"\\n'; });
      }

      // Exclude patterns
      const excludeTags = collectTags("excludeTags");
      if (excludeTags.length > 0) {
        yaml += "  exclude_patterns:\\n";
        excludeTags.forEach(t => { yaml += '    - "' + t + '"\\n'; });
      }

      pre.textContent = yaml.replace(/\\\\n/g, "\\n");
    }
  </script>
</body>
</html>`;
  }
}
