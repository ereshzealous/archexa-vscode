import * as vscode from "vscode";
import { SidebarProvider } from "../sidebarProvider.js";

export interface QueryServices {
  sidebar: SidebarProvider;
}

export function registerQueryCommands(
  services: QueryServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand("archexa.query", async () => {
      const question = await vscode.window.showInputBox({
        prompt: "Ask anything about your codebase",
        placeHolder: "How does authentication work?",
        ignoreFocusOut: true,
      });
      if (!question?.trim()) return;

      await sidebar.runCommand(
        "query",
        ["--query", question],
        `Query — ${question.slice(0, 48)}`
      );
    }),
  ];
}
