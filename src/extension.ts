import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Logger } from "./utils/logger.js";
import { BinaryManager } from "./binaryManager.js";
import { OnboardingWebview } from "./onboardingWebview.js";
import { ConfigManager } from "./configManager.js";
import { ArchexaBridge } from "./bridge.js";
import { DiagnosticsManager } from "./diagnosticsManager.js";
import { StatusBarItem } from "./statusBarItem.js";
import { SidebarProvider, HistoryEntry } from "./sidebarProvider.js";
import { ArchexaWebviewPanel } from "./webviewPanel.js";
import { registerDiagnoseCommands } from "./commands/diagnose.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerQueryCommands } from "./commands/query.js";
import { registerImpactCommands } from "./commands/impact.js";
import { registerGistCommands } from "./commands/gist.js";
import { registerAnalyzeCommands } from "./commands/analyze.js";
import { registerExplainCommands } from "./commands/explain.js";
import { WelcomeWebview } from "./welcomeWebview.js";

const SUPPORTED_LANG_IDS = new Set([
  "python",
  "typescript",
  "javascript",
  "go",
  "java",
  "rust",
  "ruby",
  "csharp",
  "kotlin",
  "scala",
  "cpp",
  "c",
  "php",
]);

export async function activate(
  ctx: vscode.ExtensionContext
): Promise<void> {
  const logger = new Logger("Archexa");

  // 1. Binary
  const binManager = new BinaryManager(ctx, logger);
  let binaryPath = "";

  try {
    binaryPath = await binManager.ensureBinary();
  } catch {
    // Binary not found — show onboarding wizard
    logger.info("No binary found — launching onboarding");
  }

  // Sidebar (registered early so it's always available)
  const sidebar = new SidebarProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("archexa.sidebar", sidebar)
  );

  // Always register these commands so they work even without binary
  ctx.subscriptions.push(
    vscode.commands.registerCommand("archexa.openSettings", async () => {
      // Ensure sidebar is visible before switching to settings screen
      await vscode.commands.executeCommand("workbench.view.extension.archexa-sidebar");
      // Small delay to ensure the webview view is resolved
      setTimeout(() => sidebar.showSettings(), 150);
    }),
    vscode.commands.registerCommand("archexa.showSetup", () => {
      const onboarding = new OnboardingWebview(ctx, binManager, logger);
      void onboarding.show();
    }),
    vscode.commands.registerCommand("archexa.checkBinary", () =>
      binManager.forceUpdate()
    )
  );

  if (!binaryPath) {
    // Show onboarding and wait for user to download + reload
    const onboarding = new OnboardingWebview(ctx, binManager, logger);
    await onboarding.show();
    return;
  }

  // 2. Config
  const configManager = new ConfigManager(binaryPath, logger);
  const configPath = await configManager.findOrCreate();

  // 3. Services
  const bridge = new ArchexaBridge(binaryPath, configPath, logger);
  const diagnostics = new DiagnosticsManager(ctx);
  const statusBar = new StatusBarItem();

  // Wire chat services into the sidebar
  sidebar.setServices({
    bridge,
    diagnostics,
    statusBar,
    logger,
    extensionUri: ctx.extensionUri,
  });

  const services = {
    bridge,
    diagnostics,
    statusBar,
    sidebar,
    logger,
    extensionUri: ctx.extensionUri,
  };

  ctx.subscriptions.push(statusBar, diagnostics);

  // 5. Commands
  ctx.subscriptions.push(
    ...registerDiagnoseCommands(services),
    ...registerReviewCommands(services),
    ...registerQueryCommands(services),
    ...registerImpactCommands(services),
    ...registerGistCommands(services),
    ...registerAnalyzeCommands(services),
    ...registerExplainCommands(services),

    vscode.commands.registerCommand("archexa.cancelCurrentRun", () => {
      statusBar.cancelCurrentRun();
    }),
    vscode.commands.registerCommand("archexa.clearHistory", () => {
      sidebar.clearHistory();
    }),
    vscode.commands.registerCommand("archexa.clearFindings", () => {
      diagnostics.clearAll();
    }),
    vscode.commands.registerCommand(
      "archexa.reopenResult",
      (entry: HistoryEntry) => {
        const panel = ArchexaWebviewPanel.getOrCreate(
          entry.cmd,
          entry.title,
          vscode.ViewColumn.Beside,
          ctx.extensionUri
        );
        panel.setContentDirect(entry.markdown, entry.durationMs, entry.promptTokens, entry.completionTokens);
      }
    ),
    vscode.commands.registerCommand("archexa.welcome", () => {
      WelcomeWebview.show(ctx);
    })
  );

  // 6. Show welcome page on first activation
  WelcomeWebview.showIfFirstTime(ctx);

  // 7. Auto-review on save
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (
        !vscode.workspace
          .getConfiguration("archexa")
          .get<boolean>("autoReviewOnSave")
      ) {
        return;
      }
      if (!SUPPORTED_LANG_IDS.has(doc.languageId)) return;
      await vscode.commands.executeCommand(
        "archexa.reviewFile",
        doc.uri
      );
    })
  );

  statusBar.setIdle();
  logger.info(`Archexa activated — ${binaryPath}`);

  // 8. Check if .archexa/ is in .gitignore (one-time per workspace)
  checkGitignore(ctx);
}

async function checkGitignore(ctx: vscode.ExtensionContext): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) return;

  // Only prompt once per workspace
  const key = "archexa.gitignoreChecked";
  if (ctx.workspaceState.get<boolean>(key)) return;

  const gitignorePath = path.join(wsRoot, ".gitignore");

  // Check if .gitignore exists and already contains .archexa
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // No .gitignore — skip, user may not be using git
    return;
  }

  const lines = content.split("\n").map(l => l.trim());
  if (lines.some(l => l === ".archexa" || l === ".archexa/" || l === ".archexa/**")) {
    void ctx.workspaceState.update(key, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Archexa stores config and output in .archexa/ — add it to .gitignore?",
    "Add to .gitignore",
    "Dismiss"
  );

  if (choice === "Add to .gitignore") {
    const entries = "\n# Archexa (AI codebase intelligence)\n.archexa/\n.archexa_cache/\n";
    fs.appendFileSync(gitignorePath, entries, "utf8");
    vscode.window.showInformationMessage("Added .archexa/ and .archexa_cache/ to .gitignore");
  }

  void ctx.workspaceState.update(key, true);
}

export function deactivate(): void {}
