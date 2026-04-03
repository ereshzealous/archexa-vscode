import * as vscode from "vscode";
import { SidebarProvider } from "../sidebarProvider.js";

export interface GistServices {
  sidebar: SidebarProvider;
}

export function registerGistCommands(
  services: GistServices
): vscode.Disposable[] {
  const { sidebar } = services;
  return [
    vscode.commands.registerCommand("archexa.gist", async () => {
      await sidebar.runCommand("gist", [], "Quick Gist");
    }),
  ];
}
