import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebarProvider.js";

export interface ImpactServices {
  sidebar: SidebarProvider;
}

export function registerImpactCommands(
  services: ImpactServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand(
      "archexa.impactFile",
      async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
        // Resolve target file(s)
        const fileUris = (allUris && allUris.length > 1)
          ? allUris.filter(u => u.scheme === "file")
          : undefined;

        let target: string;
        let label: string;

        if (fileUris && fileUris.length > 1) {
          const relPaths = fileUris.map(u => vscode.workspace.asRelativePath(u));
          target = relPaths.join(",");
          label = relPaths.length <= 3
            ? relPaths.map(p => path.basename(p)).join(", ")
            : `${relPaths.length} files`;
        } else {
          const fileUri = uri?.scheme === "file" ? uri : undefined;
          const editorUri = vscode.window.activeTextEditor?.document.uri;
          const resolvedUri = fileUri ?? (editorUri?.scheme === "file" ? editorUri : undefined);
          if (!resolvedUri?.fsPath) {
            vscode.window.showWarningMessage("Open a file first");
            return;
          }
          target = vscode.workspace.asRelativePath(resolvedUri);
          label = path.basename(resolvedUri.fsPath);
        }

        // Ask for change description (optional but recommended)
        const query = await vscode.window.showInputBox({
          prompt: "Describe the change you're planning (optional — press Enter to skip)",
          placeHolder: "e.g. Remove JWT validation and switch to session-based auth",
          ignoreFocusOut: true,
        });
        if (query === undefined) return; // user pressed Escape

        const args = ["--target", target];
        if (query) args.push("--query", query);

        const panelTitle = query
          ? `Impact — ${label}: ${query.slice(0, 40)}`
          : `Impact — ${label}`;

        await sidebar.runCommand("impact", args, panelTitle);
      }
    ),
  ];
}
