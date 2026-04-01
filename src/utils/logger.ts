import * as vscode from "vscode";

export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(m: string): void {
    this.write("INFO", m);
  }

  warn(m: string): void {
    this.write("WARN", m);
  }

  error(m: string): void {
    this.write("ERROR", m);
  }

  debug(m: string): void {
    if (
      vscode.workspace.getConfiguration("archexa").get("logLevel") === "DEBUG"
    ) {
      this.write("DEBUG", m);
    }
  }

  private write(level: string, message: string): void {
    this.channel.appendLine(
      `[${new Date().toISOString()}] [${level}] ${message}`
    );
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
