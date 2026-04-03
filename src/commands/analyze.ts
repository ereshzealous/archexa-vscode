import * as vscode from "vscode";
import { SidebarProvider } from "../sidebarProvider.js";

export interface AnalyzeServices {
  sidebar: SidebarProvider;
}

export function registerAnalyzeCommands(
  services: AnalyzeServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand("archexa.analyze", async () => {
      await sidebar.runCommand("analyze", [], "Full Architecture Analysis");
    }),
  ];
}
