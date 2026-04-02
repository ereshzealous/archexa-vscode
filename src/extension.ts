import * as vscode from "vscode";
import { Logger } from "./utils/logger.js";
import { BinaryManager } from "./binaryManager.js";
import { OnboardingWebview } from "./onboardingWebview.js";
import { ConfigManager } from "./configManager.js";
import { ArchexaBridge } from "./bridge.js";
import { DiagnosticsManager } from "./diagnosticsManager.js";
import { StatusBarItem } from "./statusBarItem.js";
import { SidebarProvider, HistoryEntry } from "./sidebarProvider.js";
import { SettingsWebview } from "./settingsWebview.js";
import { ArchexaWebviewPanel } from "./webviewPanel.js";
import { registerDiagnoseCommands } from "./commands/diagnose.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerQueryCommands } from "./commands/query.js";
import { registerImpactCommands } from "./commands/impact.js";
import { registerGistCommands } from "./commands/gist.js";
import { registerAnalyzeCommands } from "./commands/analyze.js";
import { registerExplainCommands } from "./commands/explain.js";
import { ChatWebview } from "./chatWebview.js";
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

  // Always register these commands so they work even without binary
  const settings = new SettingsWebview(ctx);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("archexa.openSettings", () =>
      settings.show()
    ),
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
  const sidebar = new SidebarProvider(ctx);

  const services = {
    bridge,
    diagnostics,
    statusBar,
    sidebar,
    logger,
    extensionUri: ctx.extensionUri,
  };

  ctx.subscriptions.push(statusBar, diagnostics);

  // 4. Sidebar (webview)
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("archexa.sidebar", sidebar)
  );

  // 5. Commands
  ctx.subscriptions.push(
    ...registerDiagnoseCommands(services),
    ...registerReviewCommands(services),
    ...registerQueryCommands(services),
    ...registerImpactCommands(services),
    ...registerGistCommands(services),
    ...registerAnalyzeCommands(services),
    ...registerExplainCommands(services),

    (() => {
      const chat = new ChatWebview(ctx, services);
      return vscode.commands.registerCommand("archexa.openChat", () => chat.show());
    })(),

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
        panel.setContentDirect(entry.markdown);
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
}

export function deactivate(): void {}
