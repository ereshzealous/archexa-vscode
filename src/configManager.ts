import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { Logger } from "./utils/logger.js";
import { generateConfigYaml } from "./utils/config.js";

export class ConfigManager {
  constructor(
    private readonly binaryPath: string,
    private readonly logger: Logger
  ) {}

  async findOrCreate(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.logger.warn("No workspace folder open — skipping config");
      return "";
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // 1. Check common locations
    for (const name of ["archexa.yaml", ".archexa.yaml"]) {
      const candidate = path.join(workspaceRoot, name);
      if (fs.existsSync(candidate)) {
        this.logger.info(`Found config: ${candidate}`);
        return candidate;
      }
    }

    // 2. Search nested directories (e.g. monorepo)
    const found = await vscode.workspace.findFiles(
      "**/archexa.yaml",
      "**/node_modules/**",
      1
    );
    if (found.length > 0) {
      this.logger.info(`Found config via search: ${found[0].fsPath}`);
      return found[0].fsPath;
    }

    // 3. Silently create one using CLI init or minimal fallback
    const configPath = path.join(workspaceRoot, "archexa.yaml");
    this.createConfig(configPath, workspaceRoot);
    this.logger.info(`Created config: ${configPath}`);
    return configPath;
  }

  private createConfig(configPath: string, workspaceRoot: string): void {
    // Try CLI init first
    try {
      cp.execFileSync(
        this.binaryPath, ["init", "--out", configPath],
        { cwd: workspaceRoot, timeout: 10000, stdio: "ignore" }
      );
      if (fs.existsSync(configPath)) return;
    } catch {
      this.logger.debug("CLI init failed — writing config from settings");
    }

    // Fallback: generate from VS Code settings
    fs.writeFileSync(configPath, generateConfigYaml(), "utf8");
  }
}
