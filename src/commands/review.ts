import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebarProvider.js";

export interface ReviewServices {
  sidebar: SidebarProvider;
}

export function registerReviewCommands(
  services: ReviewServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand(
      "archexa.reviewFile",
      async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
        // Multi-select: VS Code passes all selected URIs as second arg
        const fileUris = (allUris && allUris.length > 1)
          ? allUris.filter(u => u.scheme === "file")
          : undefined;

        if (fileUris && fileUris.length > 1) {
          // Multi-file review
          const relPaths = fileUris.map(u => vscode.workspace.asRelativePath(u));
          const target = relPaths.join(",");
          const label = relPaths.length <= 3
            ? relPaths.map(p => path.basename(p)).join(", ")
            : `${relPaths.length} files`;
          await sidebar.runCommand("review", ["--target", target], `Review — ${label}`);
        } else {
          // Single file review
          const fileUri = uri?.scheme === "file" ? uri : undefined;
          const editorUri = vscode.window.activeTextEditor?.document.uri;
          const resolvedUri = fileUri ?? (editorUri?.scheme === "file" ? editorUri : undefined);
          const filePath = resolvedUri?.fsPath;
          if (!filePath) {
            vscode.window.showWarningMessage("Open a file to review");
            return;
          }
          const relPath = vscode.workspace.asRelativePath(filePath);
          await sidebar.runCommand("review", ["--target", relPath], `Review — ${path.basename(filePath)}`);
        }
      }
    ),

    vscode.commands.registerCommand("archexa.reviewChanges", async () => {
      await sidebar.runCommand("review", ["--changed"], "Review — Uncommitted Changes");
    }),

    vscode.commands.registerCommand("archexa.reviewBranch", async () => {
      const ref = await vscode.window.showInputBox({
        prompt: "Branch ref to compare against",
        value: "origin/main..HEAD",
        placeHolder: "origin/main..HEAD",
        validateInput: (v) => v.includes("..") ? null : "Format: base..HEAD",
      });
      if (!ref) return;
      await sidebar.runCommand("review", ["--branch", ref], `Review — ${ref}`);
    }),
  ];
}
