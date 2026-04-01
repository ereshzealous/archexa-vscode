import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { ArchexaBridge } from "../bridge.js";
import { DiagnosticsManager } from "../diagnosticsManager.js";
import { StatusBarItem } from "../statusBarItem.js";
import { SidebarProvider } from "../sidebarProvider.js";
import { ArchexaWebviewPanel } from "../webviewPanel.js";
import { Logger } from "../utils/logger.js";

export interface ReviewServices {
  bridge: ArchexaBridge;
  diagnostics: DiagnosticsManager;
  statusBar: StatusBarItem;
  sidebar: SidebarProvider;
  logger: Logger;
  extensionUri: vscode.Uri;
}

async function runReview(
  cliArgs: string[],
  panelTitle: string,
  targetUri: vscode.Uri | undefined,
  services: ReviewServices
): Promise<void> {
  const { bridge, diagnostics, statusBar, sidebar, logger, extensionUri } = services;
  const tokenSource = new vscode.CancellationTokenSource();
  const cfg = vscode.workspace.getConfiguration("archexa");

  if (cfg.get<boolean>("showInlineFindings") && targetUri) {
    diagnostics.clearFile(targetUri);
  }

  const panel = ArchexaWebviewPanel.getOrCreate(
    "review", panelTitle, vscode.ViewColumn.Beside, extensionUri
  );
  panel.reset(panelTitle, "review");
  panel.setMeta(
    cfg.get<string>("model") ?? "gpt-4o",
    vscode.workspace.workspaceFolders?.[0]?.name ?? ""
  );

  statusBar.setRunning("Review", tokenSource);
  sidebar.showProgress("Starting review...", 0);

  let durationMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await bridge.run({
      command: "review",
      args: cliArgs,
      onChunk: (chunk) => panel.appendChunk(chunk),
      onProgress: (phase, total, label, detail) => {
        panel.updateProgress(phase, total, label, detail);
        const pct = total > 0 ? Math.round((phase / total) * 100) : 0;
        sidebar.showProgress(`[${phase}/${total}] ${label}`, pct);
      },
      onFinding: (f) => {
        if (cfg.get<boolean>("showInlineFindings")) diagnostics.addFinding(f);
        panel.addFindingBadge(f.severity);
      },
      onDone: (duration, prompt, completion) => { durationMs = duration; promptTokens = prompt; completionTokens = completion; },
      token: tokenSource.token,
    });
    durationMs = durationMs || result.durationMs;

    statusBar.setDone("Review complete");
    panel.setDone(durationMs, promptTokens, completionTokens);
    sidebar.addToHistory({
      id: crypto.randomUUID(), cmd: "review", title: panelTitle,
      timestamp: Date.now(), markdown: panel.getBuffer(),
    });
  } catch (err: unknown) {
    if (tokenSource.token.isCancellationRequested) {
      statusBar.setIdle();
      panel.setCancelled();
    } else {
      const message = err instanceof Error ? err.message : String(err);
      statusBar.setError(message);
      panel.showError(message);
      panel.setDone();
      logger.error(`Review failed: ${message}`);
    }
  } finally {
    sidebar.hideProgress();
    tokenSource.dispose();
  }
}

export function registerReviewCommands(
  services: ReviewServices
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "archexa.reviewFile",
      async (uri?: vscode.Uri) => {
        const fileUri = uri?.scheme === "file" ? uri : undefined;
        const editorUri = vscode.window.activeTextEditor?.document.uri;
        const resolvedUri = fileUri ?? (editorUri?.scheme === "file" ? editorUri : undefined);
        const filePath = resolvedUri?.fsPath;
        if (!filePath) {
          vscode.window.showWarningMessage("Open a file to review");
          return;
        }
        const relPath = vscode.workspace.asRelativePath(filePath);
        await runReview(
          ["--target", relPath],
          `Review — ${path.basename(filePath)}`,
          vscode.Uri.file(filePath),
          services
        );
      }
    ),

    vscode.commands.registerCommand("archexa.reviewChanges", async () => {
      await runReview(["--changed"], "Review — Uncommitted Changes", undefined, services);
    }),

    vscode.commands.registerCommand("archexa.reviewBranch", async () => {
      const ref = await vscode.window.showInputBox({
        prompt: "Branch ref to compare against",
        value: "origin/main..HEAD",
        placeHolder: "origin/main..HEAD",
        validateInput: (v) => v.includes("..") ? null : "Format: base..HEAD",
      });
      if (!ref) return;
      await runReview(["--branch", ref], `Review — ${ref}`, undefined, services);
    }),
  ];
}
