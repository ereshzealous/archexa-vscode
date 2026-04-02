import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Logger } from "./utils/logger.js";
import { generateConfigYaml } from "./utils/config.js";

export interface RunOptions {
  command: string;
  args: string[];
  supportsStdout?: boolean;
  onChunk: (text: string) => void;
  onProgress?: (phase: number, total: number, label: string, detail: string) => void;
  onFinding?: (f: ReviewFinding) => void;
  onDone?: (durationMs: number, promptTokens: number, completionTokens: number) => void;
  token?: vscode.CancellationToken;
}

export interface ReviewFinding {
  severity: "error" | "warning" | "info";
  file: string;
  line: number;
  col: number;
  message: string;
  rule?: string;
}

export interface RunResult {
  exitCode: number;
  durationMs: number;
}

export class ArchexaBridge {
  private stdoutUnsupported = false;

  constructor(
    private readonly binaryPath: string,
    private readonly initialConfigPath: string,
    private readonly logger: Logger
  ) {}

  /**
   * Spawn the Archexa CLI and stream results.
   *
   * Callback lifecycle:
   *  1. `onProgress` — called repeatedly as the CLI emits progress events.
   *  2. `onFinding`  — called for each review finding (review command only).
   *  3. `onChunk`    — called with markdown output (streamed or read from file).
   *  4. `onDone`     — called once with timing/token stats when the CLI exits successfully.
   *
   * If the run is cancelled via `token`, the promise rejects with "Cancelled".
   */
  async run(opts: RunOptions): Promise<RunResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration("archexa");
    const logLevel = cfg.get<string>("logLevel") ?? "WARNING";
    const verbose = logLevel === "DEBUG" || logLevel === "INFO";

    // Write/update config file with all current settings
    const configPath = this.resolveOrWriteConfig(workspaceRoot, cfg);

    // Minimal CLI flags — everything else comes from the config file
    // CLI v0.4.0+: --stdout auto-disables ANSI color, so --no-color only needed without --stdout.
    const useStdout = opts.supportsStdout !== false && !this.stdoutUnsupported;
    const spawnArgs = [
      ...(useStdout ? [] : ["--no-color"]),
      ...(verbose ? [] : ["--quiet"]),
      opts.command,
      ...(useStdout ? ["--stdout"] : []),
      ...(opts.onFinding ? ["--json-findings"] : []),
      "--config", configPath,
      ...opts.args,
    ];

    this.logger.info(`Config: ${configPath}`);
    this.logger.info(`Spawning: ${this.binaryPath} ${this.redactArgs(spawnArgs)}`);

    const startTime = Date.now();
    opts.onProgress?.(1, 3, "Starting analysis", "");

    // API key via env var only — never on the command line
    const apiKey = cfg.get<string>("apiKey") || process.env.OPENAI_API_KEY || "";

    return new Promise<RunResult>((resolve, reject) => {
      const proc = cp.spawn(this.binaryPath, spawnArgs, {
        cwd: workspaceRoot,
        env: { ...process.env, OPENAI_API_KEY: apiKey },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let cancelled = false;
      const cancelDisposable = opts.token?.onCancellationRequested(() => {
        if (cancelled) return;
        cancelled = true;
        this.logger.info("Cancelling: killing process");
        // Reject immediately so the command's catch block runs
        reject(new Error("Cancelled"));
        // Kill the process in the background
        try { proc.kill("SIGTERM"); } catch { /* already dead */ }
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
      });

      let stdoutBuf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        if (useStdout) {
          opts.onChunk(chunk);
        }
      });

      let stderrBuf = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (data: string) => {
        stderrBuf += data;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed) as Record<string, unknown>;
            this.dispatchEvent(evt, opts);
          } catch {
            if (verbose) {
              this.logger.info(`cli: ${trimmed}`);
            } else {
              this.logger.debug(`stderr: ${trimmed}`);
            }
            this.extractProgress(trimmed, opts);
          }
        }
      });

      proc.on("error", (err) => {
        cancelDisposable?.dispose();
        if (!cancelled) reject(new Error(`Failed to start Archexa: ${err.message}`));
      });

      proc.on("close", (code) => {
        cancelDisposable?.dispose();
        if (cancelled) return; // Already resolved in cancel handler

        const durationMs = Date.now() - startTime;
        const exitCode = code ?? 0;

        if (exitCode === 2 && useStdout && !this.stdoutUnsupported) {
          this.stdoutUnsupported = true;
          this.logger.info("--stdout not supported, retrying without it");
          resolve(this.run(opts));
          return;
        }

        if (exitCode !== 0) {
          if (stdoutBuf.trim()) this.logger.error(`CLI stdout: ${stdoutBuf.trim()}`);
          if (stderrBuf.trim()) this.logger.error(`CLI stderr: ${stderrBuf.trim()}`);
          reject(new Error(`Archexa exited ${exitCode}. View Output → Archexa for details.`));
          return;
        }

        if (!useStdout) {
          opts.onProgress?.(3, 3, "Reading output", "");
          const outputFile = this.findOutputFile(workspaceRoot, cfg);
          if (outputFile) {
            opts.onChunk(fs.readFileSync(outputFile, "utf8"));
            this.logger.info(`Read output from: ${outputFile}`);
          } else {
            opts.onChunk("*Analysis completed but no output was generated.*\n");
          }
        }

        opts.onDone?.(durationMs, 0, 0);
        resolve({ exitCode, durationMs });
      });
    });
  }

  /**
   * Resolve config: prefer user's archexa.yaml, otherwise write one from settings.
   * The config file is the single source of truth for the CLI — model, endpoint,
   * deep mode, limits, etc. all come from here, not from CLI flags.
   */
  private resolveOrWriteConfig(
    workspaceRoot: string,
    cfg: vscode.WorkspaceConfiguration
  ): string {
    for (const name of ["archexa.yaml", ".archexa.yaml"]) {
      const candidate = path.join(workspaceRoot, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (this.initialConfigPath && fs.existsSync(this.initialConfigPath)) {
      return this.initialConfigPath;
    }
    return this.writeConfigFromSettings(workspaceRoot, cfg);
  }

  /**
   * Generate archexa.yaml from VS Code settings.
   * Regenerated every run so changes are always reflected.
   */
  private writeConfigFromSettings(
    workspaceRoot: string,
    _cfg: vscode.WorkspaceConfiguration
  ): string {
    const dest = path.join(workspaceRoot, ".archexa-vscode-tmp.yaml");
    fs.writeFileSync(dest, generateConfigYaml(), "utf8");
    return dest;
  }

  private findOutputFile(
    workspaceRoot: string,
    cfg: vscode.WorkspaceConfiguration
  ): string | undefined {
    const outputDir = cfg.get<string>("outputDir") ?? "generated";
    // Check both the configured output dir and .archexa
    for (const dir of [outputDir, ".archexa", "generated"]) {
      const genDir = path.join(workspaceRoot, dir);
      if (!fs.existsSync(genDir)) continue;
      const files = fs.readdirSync(genDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({ path: path.join(genDir, f), mtime: fs.statSync(path.join(genDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0 && Date.now() - files[0].mtime < 120_000) {
        return files[0].path;
      }
    }
    return undefined;
  }

  private extractProgress(line: string, opts: RunOptions): void {
    const lower = line.toLowerCase();
    if (lower.includes("scanning") || lower.includes("scan")) {
      opts.onProgress?.(1, 3, "Scanning codebase", "");
    } else if (lower.includes("investigating") || lower.includes("agent") || lower.includes("iteration")) {
      opts.onProgress?.(2, 3, "Investigating", "");
    } else if (lower.includes("generating") || lower.includes("writing") || lower.includes("synthesis")) {
      opts.onProgress?.(3, 3, "Generating output", "");
    }
  }

  private dispatchEvent(evt: Record<string, unknown>, opts: RunOptions): void {
    if (typeof evt.type !== "string") return;
    switch (evt.type) {
      case "progress":
        if (typeof evt.phase === "number" && typeof evt.total === "number") {
          opts.onProgress?.(evt.phase, evt.total, String(evt.label ?? ""), String(evt.detail ?? ""));
        }
        break;
      case "finding":
        if (typeof evt.file === "string" && typeof evt.line === "number") {
          opts.onFinding?.({
            severity: (evt.severity as "error" | "warning" | "info") ?? "info",
            file: evt.file, line: evt.line, col: (evt.col as number) ?? 0,
            message: String(evt.message ?? ""), rule: (evt.rule as string) || undefined,
          });
        }
        break;
      case "done":
        if (typeof evt.duration_ms === "number") {
          opts.onDone?.(evt.duration_ms, (evt.prompt_tokens as number) ?? 0, (evt.completion_tokens as number) ?? 0);
        }
        break;
    }
  }

  /** Redact API keys and truncate long args for log output */
  private redactArgs(args: string[]): string {
    return args.map((a) => {
      if (a.startsWith("sk-") || a.startsWith("sk_")) return "sk-***";
      if (a.length > 120) return a.slice(0, 120) + "…";
      return a;
    }).join(" ");
  }
}
