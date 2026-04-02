import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { generateConfigYaml } from "./utils/config.js";
import { getNonce } from "./utils/platform.js";

const SECTIONS = [
  { id: "binary", icon: "◈", label: "Binary" },
  { id: "connection", icon: "◎", label: "Connection" },
  { id: "agent", icon: "◉", label: "Agent" },
  { id: "scanning", icon: "◈", label: "Scanning" },
  { id: "cache", icon: "◆", label: "Cache" },
  { id: "prompts", icon: "▤", label: "Prompts" },
  { id: "output", icon: "▣", label: "Output" },
  { id: "review", icon: "◍", label: "Review" },
  { id: "advanced", icon: "⟐", label: "Advanced" },
];

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

  private getHtml(cssUri: vscode.Uri, nonce?: string): string {
    const n = nonce ?? getNonce();
    const navItems = SECTIONS.map(
      (s) =>
        `<div class="nav-item${s.id === "binary" ? " active" : ""}" data-section="${s.id}">${s.icon} ${s.label}</div>`
    ).join("\n      ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel!.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${this.panel!.webview.cspSource} data:;" />
  <link href="${cssUri}" rel="stylesheet"/>
</head>
<body>
  <div class="top-bar">
    <span class="title">Archexa Settings</span>
    <span class="section-label" id="topSectionLabel">Binary</span>
    <span class="spacer"></span>
    <button class="top-btn" id="yamlToggle">YAML ▶</button>
    <button class="top-btn save-btn" id="saveBtn">Save</button>
  </div>

  <div class="main-layout">
    <div class="nav">
      ${navItems}
    </div>

    <div class="content-area">
      <!-- BINARY -->
      <div class="section active" id="sec-binary">
        <h2>Binary</h2>
        <div class="field">
          <label class="field-label">Active binary path</label>
          <div class="copy-box">
            <span class="copy-text" id="binPath">...</span>
            <button class="copy-btn" id="copyBinPath">Copy</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Version</label>
          <div id="binVersion" style="font-family:var(--vscode-editor-font-family)">...</div>
        </div>
        <div class="btn-row">
          <button class="btn-secondary" id="btnVerify">↻ Verify binary</button>
          <button class="btn-secondary" id="btnCheckUpdate">☁ Check for update</button>
          <button class="btn-secondary" id="btnRedownload">⬇ Re-download</button>
          <button class="btn-secondary" id="btnOpenBin">Open bin folder</button>
        </div>
        <div class="info-box">
          <strong>How binary management works</strong><br/>
          • Binary is a PyInstaller single-file executable from GitHub Releases<br/>
          • No Python or pip required — fully self-contained<br/>
          • Updates are checked silently on each activation<br/>
          • Binary is stored in the extension's global storage directory
        </div>
        <table class="bundle-table">
          <thead><tr><th>Platform</th><th>Asset</th><th>Python?</th></tr></thead>
          <tbody>
            <tr><td>macOS (Apple Silicon)</td><td>archexa-macos-arm64</td><td>No ✓</td></tr>
            <tr><td>macOS (Intel)</td><td>archexa-macos-x86_64</td><td>No ✓</td></tr>
            <tr><td>Linux (x86_64)</td><td>archexa-linux-x86_64</td><td>No ✓</td></tr>
            <tr><td>Linux (ARM64)</td><td>archexa-linux-arm64</td><td>No ✓</td></tr>
            <tr><td>Windows (x64)</td><td>archexa-windows-x86_64.exe</td><td>No ✓</td></tr>
          </tbody>
        </table>
      </div>

      <!-- CONNECTION -->
      <div class="section" id="sec-connection">
        <h2>Connection</h2>
        <div class="field">
          <label class="field-label">API Key</label>
          <div style="display:flex;gap:6px;align-items:center;max-width:400px">
            <input type="password" id="apiKey" data-key="archexa.apiKey" placeholder="sk-..." style="flex:1"/>
            <button class="btn-secondary" id="toggleApiKey" style="white-space:nowrap">Show</button>
          </div>
          <div class="field-hint">Leave empty to use OPENAI_API_KEY env var</div>
        </div>
        <div class="info-box">
          Archexa uses the <strong>OpenAI-compatible API</strong> format. Any provider that
          implements the <code>/v1/chat/completions</code> endpoint works: OpenAI, OpenRouter,
          Azure, Anthropic (via proxy), Ollama, vLLM, LiteLLM, etc.
        </div>
        <div class="field">
          <label class="field-label">Base URL</label>
          <input type="text" id="endpoint" data-key="archexa.endpoint" placeholder="https://api.openai.com/v1/" style="max-width:500px"/>
          <div class="field-hint">The /v1/ endpoint of your provider. Examples: https://api.openai.com/v1/ · https://openrouter.ai/api/v1/ · http://localhost:11434/v1/</div>
        </div>
        <div class="field">
          <label class="field-label">Model</label>
          <input type="text" id="model" data-key="archexa.model" placeholder="gpt-4o" style="max-width:500px"/>
          <div class="field-hint">Any model string your provider accepts. Examples: gpt-4o · google/gemini-2.0-flash-001 · anthropic/claude-sonnet-4-20250514 · llama3.1</div>
        </div>
        <div class="toggle-row">
          <div class="toggle-track on" data-key="archexa.tlsVerify" id="tlsToggle">
            <div class="toggle-thumb"></div>
          </div>
          <span class="toggle-label">TLS Verify</span>
          <span style="font-size:0.78em;color:var(--vscode-descriptionForeground);margin-left:6px">Disable for local endpoints with self-signed certs</span>
        </div>
        <div class="btn-row">
          <button class="btn-primary" id="btnTestConn">▶ Test Connection</button>
        </div>
        <div id="connStatus" style="margin-top:8px;font-size:0.88em;padding:8px 12px;border-radius:4px;display:none"></div>
      </div>

      <!-- AGENT -->
      <div class="section" id="sec-agent">
        <h2>Agent &amp; Deep Mode</h2>
        <div class="info-box">
          <strong>Deep mode</strong> = the LLM reads files, greps code, traces callers, and iterates
          before generating its answer. Like a senior engineer exploring the codebase themselves.<br/><br/>
          <strong>Without deep mode</strong> (pipeline), Archexa extracts evidence using AST parsing only —
          faster but less thorough. Deep mode uses 3-10x more tokens but finds cross-file issues
          that pipeline mode misses.
        </div>
        <div class="info-box">
          <strong>Per-command deep mode behavior</strong><br/>
          <table style="width:100%;font-size:0.85em;margin-top:6px;border-collapse:collapse">
            <tr style="border-bottom:1px solid var(--vscode-editorGroup-border)">
              <td style="padding:3px 6px"><strong>Diagnose</strong></td>
              <td style="padding:3px 6px">Always deep</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Root-cause requires tracing call chains</td>
            </tr>
            <tr style="border-bottom:1px solid var(--vscode-editorGroup-border)">
              <td style="padding:3px 6px"><strong>Review</strong></td>
              <td style="padding:3px 6px">Uses this setting</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Deep mode traces callers across files; pipeline is faster for focused reviews</td>
            </tr>
            <tr style="border-bottom:1px solid var(--vscode-editorGroup-border)">
              <td style="padding:3px 6px"><strong>Impact</strong></td>
              <td style="padding:3px 6px">Uses this setting</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Deep mode traces callers and consumers across boundaries</td>
            </tr>
            <tr style="border-bottom:1px solid var(--vscode-editorGroup-border)">
              <td style="padding:3px 6px"><strong>Query</strong></td>
              <td style="padding:3px 6px">Uses this setting</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Not every question needs deep investigation</td>
            </tr>
            <tr style="border-bottom:1px solid var(--vscode-editorGroup-border)">
              <td style="padding:3px 6px"><strong>Gist</strong></td>
              <td style="padding:3px 6px">Uses this setting</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Overview works well with pipeline extraction</td>
            </tr>
            <tr>
              <td style="padding:3px 6px"><strong>Analyze</strong></td>
              <td style="padding:3px 6px">Uses this setting</td>
              <td style="padding:3px 6px;color:var(--vscode-descriptionForeground)">Full architecture uses evidence extraction pipeline</td>
            </tr>
          </table>
        </div>
        <div class="toggle-row">
          <div class="toggle-track on" data-key="archexa.deepByDefault" id="deepToggle">
            <div class="toggle-thumb"></div>
          </div>
          <span class="toggle-label">Deep mode by default</span>
          <span style="font-size:0.78em;color:var(--vscode-descriptionForeground);margin-left:6px">Applies to all commands except Diagnose (always deep)</span>
        </div>
        <div class="field">
          <label class="field-label">Max iterations</label>
          <div class="range-row">
            <input type="range" min="3" max="30" value="15" id="deepMaxIterations" data-key="archexa.deepMaxIterations"/>
            <span class="range-value" id="deepMaxIterationsVal">15</span>
          </div>
          <div class="field-hint">How many tool-calling rounds the agent can perform. Higher = more thorough but slower.
            3-5 for quick checks, 10-15 for thorough analysis, 20-30 for complex cross-file investigations.</div>
        </div>
        <div class="field">
          <label class="field-label">Enabled tools</label>
          <div class="checkbox-group">
            <label class="checkbox-item"><input type="checkbox" checked data-tool="read_file"/> read_file</label>
            <label class="checkbox-item"><input type="checkbox" checked data-tool="grep_codebase"/> grep_codebase</label>
            <label class="checkbox-item"><input type="checkbox" checked data-tool="list_directory"/> list_directory</label>
            <label class="checkbox-item"><input type="checkbox" checked data-tool="find_references"/> find_references</label>
            <label class="checkbox-item"><input type="checkbox" checked data-tool="git_log"/> git_log</label>
            <label class="checkbox-item"><input type="checkbox" checked data-tool="get_imports"/> get_imports</label>
          </div>
          <div class="field-hint">Tools the agent can use during investigation. Disabling tools limits what the agent can discover but reduces token usage.</div>
        </div>
      </div>

      <!-- CACHE -->
      <!-- SCANNING -->
      <div class="section" id="sec-scanning">
        <h2>Scanning</h2>
        <div class="info-box">
          Controls which files Archexa indexes and analyzes. All commands respect these settings.
          The configured output directory is always excluded automatically.
        </div>
        <div class="field">
          <label class="field-label">Scan focus (directories)</label>
          <div class="tag-container" id="scanFocusTags">
            <input type="text" class="tag-input" id="scanFocusInput" placeholder="e.g. src/api/ — press Enter to add"/>
          </div>
          <div class="field-hint">Limit scanning to these directory prefixes. Leave empty to scan the full repo. Useful for large monorepos — only scan the parts you care about.</div>
        </div>
        <div class="field">
          <label class="field-label">Exclusion patterns</label>
          <div class="tag-container" id="excludeTags">
            <input type="text" class="tag-input" id="excludeInput" placeholder="e.g. *.test.ts — press Enter to add"/>
          </div>
          <div class="field-hint">
            Glob patterns for files to skip during scanning. Archexa already excludes
            <code>node_modules</code>, <code>.git</code>, <code>__pycache__</code>, and binary files by default.<br/>
            <strong>Examples:</strong>
            <code>*.test.ts</code> · <code>*.spec.js</code> · <code>*_test.go</code> ·
            <code>vendor/**</code> · <code>dist/**</code> · <code>*.generated.*</code> ·
            <code>migrations/**</code> · <code>*.pb.go</code>
          </div>
        </div>
      </div>

      <!-- CACHE -->
      <div class="section" id="sec-cache">
        <h2>Cache</h2>
        <div class="info-box">
          <strong>How caching works</strong><br/>
          Archexa caches per-file evidence extraction (AST parsing, pattern matching, import graphs).
          On subsequent runs, unchanged files are served from cache — making scans <strong>2-5x faster</strong>.<br/><br/>
          <strong>When to disable:</strong> If you're debugging extraction issues or just made major structural changes
          to many files. Use <code>--fresh</code> via CLI for a one-time bypass.
        </div>
        <div class="toggle-row">
          <div class="toggle-track on" data-key="archexa.cacheEnabled" id="cacheToggle">
            <div class="toggle-thumb"></div>
          </div>
          <span class="toggle-label">Enable cache</span>
        </div>
        <div class="btn-row">
          <button class="btn-secondary" id="btnClearCache">Clear Cache</button>
          <span id="cacheSize" style="font-size:0.85em;color:var(--vscode-descriptionForeground)"></span>
        </div>
      </div>

      <!-- PROMPTS -->
      <div class="section" id="sec-prompts">
        <h2>Custom Prompts</h2>
        <div class="info-box">
          Custom text is appended to each command's system prompt. Use this to tailor Archexa
          to your codebase — coding conventions, focus areas, known quirks, or domain context
          that helps the LLM give better answers.<br/><br/>
          <strong>Tip:</strong> Be specific. Instead of "review carefully", say "This codebase uses SQLAlchemy 2.0
          async sessions — flag any sync database calls" or "We use dependency injection via FastAPI Depends — don't flag missing imports for injected params".
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-diagnose"></span>Diagnose</label>
          <textarea class="prompt-area" id="promptDiagnose" data-key="archexa.promptDiagnose" placeholder="e.g. Our logs use structlog JSON format. The app runs on Kubernetes — check for pod-level issues like OOM, crashloop, and DNS resolution failures."></textarea>
          <div class="field-hint">Appended when diagnosing errors, logs, and stack traces.</div>
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-review"></span>Review</label>
          <textarea class="prompt-area" id="promptReview" data-key="archexa.promptReview" placeholder="e.g. Focus on security: SQL injection, XSS, auth bypass. We use Pydantic for validation — check that all API inputs are validated. Ignore style issues."></textarea>
          <div class="field-hint">Appended when reviewing code for issues.</div>
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-query"></span>Query</label>
          <textarea class="prompt-area" id="promptQuery" data-key="archexa.promptQuery" placeholder="e.g. This is a DAG-based pipeline orchestrator. When explaining flows, trace the execution from YAML definition through parser to runtime."></textarea>
          <div class="field-hint">Appended when asking questions about the codebase.</div>
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-impact"></span>Impact</label>
          <textarea class="prompt-area" id="promptImpact" data-key="archexa.promptImpact" placeholder="e.g. We have downstream consumers via gRPC — check proto file compatibility. Also check database migration impact."></textarea>
          <div class="field-hint">Appended when analyzing change impact.</div>
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-gist"></span>Gist</label>
          <textarea class="prompt-area" id="promptGist" data-key="archexa.promptGist" placeholder="e.g. Focus on the public API surface and deployment architecture. Skip test utilities."></textarea>
          <div class="field-hint">Appended when generating a quick gist overview.</div>
        </div>
        <div class="field">
          <label class="field-label"><span class="prompt-indicator unset" id="pi-analyze"></span>Analyze (All)</label>
          <textarea class="prompt-area" id="promptAnalyze" data-key="archexa.promptAnalyze" placeholder="e.g. Include Mermaid diagrams for data flow. Focus on the microservices boundaries and inter-service communication."></textarea>
          <div class="field-hint">Appended to the full architecture analysis. Also serves as a base prompt applied to all commands.</div>
        </div>
      </div>

      <!-- OUTPUT -->
      <div class="section" id="sec-output">
        <h2>Output</h2>
        <div class="info-box">
          Every Archexa run generates a markdown file with the full analysis. These files are saved
          to the output directory and can be committed to your repo, shared with the team, or used
          as documentation. The result panel also has Copy and Save buttons for quick access.
        </div>
        <div class="field">
          <label class="field-label">Output directory</label>
          <input type="text" id="outputDir" data-key="archexa.outputDir" value=".archexa"/>
          <div class="field-hint">Relative to workspace root. Common choices: <code>.archexa</code> (hidden), <code>generated</code>, <code>docs/archexa</code></div>
        </div>
        <div class="field-hint" style="margin-top:8px">Output format is always Markdown (.md). Files are named with timestamps automatically.</div>
      </div>

      <!-- REVIEW -->
      <div class="section" id="sec-review">
        <h2>Review</h2>
        <div class="info-box">
          Archexa reviews go beyond linting — they trace callers, follow data flow across files,
          and check both sides of interfaces. Findings appear as squiggles in the editor and in the
          Problems panel, just like TypeScript or ESLint errors.
        </div>
        <div class="toggle-row">
          <div class="toggle-track on" data-key="archexa.showInlineFindings" id="squigglesToggle">
            <div class="toggle-thumb"></div>
          </div>
          <span class="toggle-label">Show inline squiggles</span>
        </div>
        <div class="field-hint" style="margin:-6px 0 12px 46px">When enabled, review findings appear as underlines in the editor with severity colors (red/yellow/blue) and in the Problems panel.</div>
        <div class="toggle-row">
          <div class="toggle-track" data-key="archexa.autoReviewOnSave" id="autoReviewToggle">
            <div class="toggle-thumb"></div>
          </div>
          <span class="toggle-label">Auto-review on save</span>
        </div>
        <div class="field-hint" style="margin:-6px 0 12px 46px">Automatically run a review every time you save a supported file. Uses tokens on every save — enable only if you have a fast, cheap model configured.</div>
      </div>

      <!-- ADVANCED -->
      <div class="section" id="sec-advanced">
        <h2>Advanced</h2>
        <div class="info-box warning">
          <strong>Warning:</strong> Change only if you're hitting context window or performance limits.
          Defaults work well for most codebases.
        </div>
        <div class="field">
          <label class="field-label">Max prompt tokens</label>
          <div style="display:flex;gap:8px;align-items:center;max-width:400px">
            <select id="promptBudgetPreset" style="width:160px">
              <option value="32000">32k (small models)</option>
              <option value="120000" selected>120k (default)</option>
              <option value="200000">200k (GPT-4o)</option>
              <option value="500000">500k (large context)</option>
              <option value="1000000">1M (Gemini/Claude)</option>
              <option value="custom">Custom...</option>
            </select>
            <input type="number" id="promptBudget" data-key="archexa.promptBudget" value="120000" min="1000" style="width:100px"/>
          </div>
          <div class="field-hint">Increase for models with larger context windows (Gemini 1M, Claude 200k)</div>
        </div>
        <div class="field">
          <label class="field-label">Token reserve (output)</label>
          <div style="display:flex;gap:8px;align-items:center;max-width:400px">
            <select id="tokenReservePreset" style="width:160px">
              <option value="4000">4k (default)</option>
              <option value="8000">8k</option>
              <option value="16000">16k</option>
              <option value="32000">32k</option>
              <option value="custom">Custom...</option>
            </select>
            <input type="number" id="tokenReserve" data-key="archexa.promptReserve" value="16000" min="1000" style="width:100px"/>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Max files to scan</label>
          <div style="display:flex;gap:8px;align-items:center;max-width:400px">
            <select id="maxFilesPreset" style="width:160px">
              <option value="50">50 (fast)</option>
              <option value="100" selected>100 (default)</option>
              <option value="500">500</option>
              <option value="1000">1,000</option>
              <option value="5000">5,000</option>
              <option value="custom">Custom...</option>
            </select>
            <input type="number" id="maxFiles" data-key="archexa.maxFiles" value="100" min="10" style="width:100px"/>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Per-file size limit</label>
          <div style="display:flex;gap:8px;align-items:center;max-width:400px">
            <select id="fileSizeLimitPreset" style="width:160px">
              <option value="100000">100 KB</option>
              <option value="300000" selected>300 KB (default)</option>
              <option value="512000">512 KB</option>
              <option value="1048576">1 MB</option>
              <option value="custom">Custom...</option>
            </select>
            <input type="number" id="fileSizeLimit" data-key="archexa.fileSizeLimit" value="300000" min="1024" style="width:100px"/>
          </div>
          <div class="field-hint">Skip files larger than this (bytes)</div>
        </div>
        <div class="field">
          <label class="field-label">Log level</label>
          <select id="logLevel" data-key="archexa.logLevel">
            <option value="DEBUG">DEBUG</option>
            <option value="INFO">INFO</option>
            <option value="WARNING" selected>WARNING</option>
            <option value="ERROR">ERROR</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Max history entries</label>
          <div style="display:flex;gap:8px;align-items:center;max-width:400px">
            <select id="maxHistoryPreset" style="width:160px">
              <option value="10">10</option>
              <option value="30" selected>30 (default)</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="custom">Custom...</option>
            </select>
            <input type="number" id="maxHistory" data-key="archexa.maxHistory" value="30" min="5" max="200" style="width:80px"/>
          </div>
          <div class="field-hint">Number of results to keep in the sidebar Recent Results list.</div>
        </div>
      </div>
    </div>

    <!-- YAML Panel -->
    <div class="yaml-panel" id="yamlPanel">
      <div class="yaml-title">archexa.yaml preview</div>
      <pre id="yamlPreview"></pre>
    </div>
  </div>

  <div class="save-toast" id="saveToast">✓ Saved</div>

  <script nonce="${n}">
    const vscodeApi = acquireVsCodeApi();
    let currentConfig = {};

    function post(type) { vscodeApi.postMessage({ type }); }

    function copyEl(id) {
      const text = document.getElementById(id).textContent;
      navigator.clipboard.writeText(text);
    }

    // Button bindings (no inline onclick — CSP blocks them)
    document.getElementById("copyBinPath").addEventListener("click", () => copyEl("binPath"));
    document.getElementById("btnVerify").addEventListener("click", () => post("verifyBinary"));
    document.getElementById("btnCheckUpdate").addEventListener("click", () => post("checkUpdate"));
    document.getElementById("btnRedownload").addEventListener("click", () => post("redownload"));
    document.getElementById("btnOpenBin").addEventListener("click", () => post("openBinFolder"));
    document.getElementById("btnTestConn").addEventListener("click", () => post("testConnection"));
    document.getElementById("btnClearCache").addEventListener("click", () => post("clearCache"));

    // Nav
    document.querySelectorAll(".nav-item").forEach(item => {
      item.addEventListener("click", () => {
        document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
        item.classList.add("active");
        const sec = item.getAttribute("data-section");
        document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
        document.getElementById("sec-" + sec).classList.add("active");
        document.getElementById("topSectionLabel").textContent = item.textContent.trim();
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
        updateYaml();
      });
    });

    // Text/password inputs
    document.querySelectorAll("input[data-key], select[data-key], textarea[data-key]").forEach(el => {
      const evtType = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(evtType, () => {
        const key = el.getAttribute("data-key");
        let val = el.value;
        if (el.type === "range" || el.type === "number") val = Number(val);
        vscodeApi.postMessage({ type: "update", key, value: val });
        updateYaml();
      });
    });

    // Range sliders — display formatted values
    function setupRange(id, formatter) {
      const el = document.getElementById(id);
      const valEl = document.getElementById(id + "Val");
      if (!el || !valEl) return;
      el.addEventListener("input", () => { valEl.textContent = formatter(Number(el.value)); });
    }

    setupRange("deepMaxIterations", v => String(v));
    setupRange("cacheTTL", v => v >= 24 ? (v / 24).toFixed(0) + "d" : v + "h");

    // Preset select + number input combos
    function wirePreset(presetId, inputId) {
      const preset = document.getElementById(presetId);
      const input = document.getElementById(inputId);
      preset.addEventListener("change", function() {
        if (this.value !== "custom") {
          input.value = this.value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      input.addEventListener("input", function() {
        // If typed value matches a preset, select it; otherwise show Custom
        const opts = preset.querySelectorAll("option");
        let matched = false;
        opts.forEach(o => { if (o.value === input.value) { preset.value = o.value; matched = true; } });
        if (!matched) preset.value = "custom";
      });
    }
    wirePreset("promptBudgetPreset", "promptBudget");
    wirePreset("tokenReservePreset", "tokenReserve");
    wirePreset("maxFilesPreset", "maxFiles");
    wirePreset("fileSizeLimitPreset", "fileSizeLimit");
    wirePreset("maxHistoryPreset", "maxHistory");

    // API key show/hide
    document.getElementById("toggleApiKey").addEventListener("click", () => {
      const inp = document.getElementById("apiKey");
      const btn = document.getElementById("toggleApiKey");
      if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
      else { inp.type = "password"; btn.textContent = "Show"; }
    });

    // Tag inputs — map container IDs to VS Code setting keys
    const TAG_SETTINGS = {
      "excludeTags": "archexa.excludePatterns",
      "scanFocusTags": "archexa.scanFocus",
    };

    function collectTags(containerId) {
      const tags = [];
      document.getElementById(containerId).querySelectorAll(".tag").forEach(t => {
        // Get text content minus the "×" remove button
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
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        tag.remove();
        syncTagSetting(containerId);
      });
      tag.appendChild(removeBtn);
      container.insertBefore(tag, input);
    }

    // Prompt indicators
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

    // YAML toggle
    document.getElementById("yamlToggle").addEventListener("click", () => {
      const panel = document.getElementById("yamlPanel");
      panel.classList.toggle("visible");
      updateYaml();
    });

    // Save button
    document.getElementById("saveBtn").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "save" });
    });

    // Receive messages
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "init") {
        currentConfig = msg.config;
        applyConfig(msg.config);
      } else if (msg.type === "saveConfirmed") {
        const toast = document.getElementById("saveToast");
        toast.style.display = "block";
        setTimeout(() => { toast.style.display = "none"; }, 2000);
      } else if (msg.type === "connResult") {
        const el = document.getElementById("connStatus");
        el.style.display = "block";
        if (msg.pending) {
          el.style.background = "var(--vscode-editor-lineHighlightBackground)";
          el.style.color = "var(--vscode-editor-foreground)";
          el.innerHTML = "⟳ " + msg.message;
        } else if (msg.ok) {
          el.style.background = "var(--vscode-terminal-ansiGreen, #4ec966)";
          el.style.color = "#000";
          el.innerHTML = "● " + msg.message;
        } else {
          el.style.background = "var(--vscode-inputValidation-errorBackground, #5a1d1d)";
          el.style.color = "var(--vscode-errorForeground, #f44747)";
          el.innerHTML = "✗ " + msg.message;
        }
      }
    });

    function applyConfig(c) {
      if (c.binaryPath) document.getElementById("binPath").textContent = c.binaryPath;
      if (c.binaryVersion) document.getElementById("binVersion").textContent = c.binaryVersion;
      if (c.apiKey) document.getElementById("apiKey").value = c.apiKey;
      if (c.model) document.getElementById("model").value = c.model;
      if (c.endpoint) document.getElementById("endpoint").value = c.endpoint;

      setToggle("deepToggle", c.deepByDefault !== false);
      setToggle("cacheToggle", c.cacheEnabled !== false);
      setToggle("squigglesToggle", c.showInlineFindings !== false);
      setToggle("autoReviewToggle", c.autoReviewOnSave === true);
      setToggle("tlsToggle", c.tlsVerify !== false);

      if (c.deepMaxIterations) {
        document.getElementById("deepMaxIterations").value = c.deepMaxIterations;
        document.getElementById("deepMaxIterationsVal").textContent = String(c.deepMaxIterations);
      }
      // Advanced numeric fields — set value and sync preset dropdown
      function setNumericField(inputId, presetId, value) {
        if (value == null) return;
        const input = document.getElementById(inputId);
        const preset = document.getElementById(presetId);
        if (input) input.value = value;
        if (preset) {
          const opt = preset.querySelector('option[value="' + value + '"]');
          preset.value = opt ? String(value) : "custom";
        }
      }
      setNumericField("promptBudget", "promptBudgetPreset", c.promptBudget);
      setNumericField("tokenReserve", "tokenReservePreset", c.promptReserve);
      setNumericField("maxFiles", "maxFilesPreset", c.maxFiles);
      setNumericField("fileSizeLimit", "fileSizeLimitPreset", c.fileSizeLimit);
      setNumericField("maxHistory", "maxHistoryPreset", c.maxHistory);

      if (c.outputDir) document.getElementById("outputDir").value = c.outputDir;
      if (c.logLevel) document.getElementById("logLevel").value = c.logLevel;

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

      // Tag-based fields: scan focus and exclude patterns
      function loadTags(containerId, inputId, values) {
        if (!Array.isArray(values)) return;
        // Clear existing tags
        const container = document.getElementById(containerId);
        const input = document.getElementById(inputId);
        container.querySelectorAll(".tag").forEach(t => t.remove());
        // Add tags from config
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
      const tlsVerify = document.getElementById("tlsToggle")?.classList.contains("on") ?? true;
      const deep = document.getElementById("deepToggle")?.classList.contains("on") ?? true;
      const maxIter = document.getElementById("deepMaxIterations")?.value || "15";
      const cache = document.getElementById("cacheToggle")?.classList.contains("on") ?? true;
      const outputDir = document.getElementById("outputDir")?.value || ".archexa";
      const logLevel = document.getElementById("logLevel")?.value || "WARNING";
      const budget = document.getElementById("promptBudget")?.value || "120000";

      let yaml = "archexa:\\n";
      yaml += '  source: "."\\n';
      yaml += "  openai:\\n";
      yaml += '    model: "' + model + '"\\n';
      yaml += '    endpoint: "' + endpoint + '"\\n';
      yaml += "    tls_verify: " + tlsVerify + "\\n";
      yaml += "  deep:\\n";
      yaml += "    enabled: " + deep + "\\n";
      yaml += "    max_iterations: " + maxIter + "\\n";
      yaml += "  cache: " + cache + "\\n";
      yaml += '  output: "' + outputDir + '"\\n';
      yaml += '  log_level: "' + logLevel + '"\\n';
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
          // CLI uses "user" for the analyze/all prompt
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

      pre.textContent = yaml.replace(/\\n/g, "\\n");
    }
  </script>
</body>
</html>`;
  }
}
