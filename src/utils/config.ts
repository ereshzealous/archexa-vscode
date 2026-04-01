import * as vscode from "vscode";

/** Default values for all Archexa settings */
export const DEFAULTS = {
  model: "gpt-4o",
  endpoint: "https://api.openai.com/v1/",
  tlsVerify: true,
  deepByDefault: true,
  deepMaxIterations: 15,
  cacheEnabled: true,
  outputDir: "generated",
  logLevel: "WARNING",
  maxFiles: 100,
  promptBudget: 120000,
  promptReserve: 16000,
  fileSizeLimit: 300000,
  maxHistory: 30,
} as const;

/** Generate archexa.yaml content from current VS Code settings */
export function generateConfigYaml(): string {
  const cfg = vscode.workspace.getConfiguration("archexa");
  return [
    "archexa:",
    '  source: "."',
    "  openai:",
    `    model: "${cfg.get<string>("model") ?? DEFAULTS.model}"`,
    `    endpoint: "${cfg.get<string>("endpoint") ?? DEFAULTS.endpoint}"`,
    `    tls_verify: ${cfg.get<boolean>("tlsVerify") ?? DEFAULTS.tlsVerify}`,
    "  deep:",
    `    enabled: ${cfg.get<boolean>("deepByDefault") ?? DEFAULTS.deepByDefault}`,
    `    max_iterations: ${cfg.get<number>("deepMaxIterations") ?? DEFAULTS.deepMaxIterations}`,
    `  cache: ${cfg.get<boolean>("cacheEnabled") ?? DEFAULTS.cacheEnabled}`,
    `  output: "${cfg.get<string>("outputDir") ?? DEFAULTS.outputDir}"`,
    `  log_level: "${cfg.get<string>("logLevel") ?? DEFAULTS.logLevel}"`,
    "  limits:",
    `    max_files: ${cfg.get<number>("maxFiles") ?? DEFAULTS.maxFiles}`,
    `    prompt_budget: ${cfg.get<number>("promptBudget") ?? DEFAULTS.promptBudget}`,
    `    prompt_reserve: ${cfg.get<number>("promptReserve") ?? DEFAULTS.promptReserve}`,
    "  evidence:",
    `    file_size_limit: ${cfg.get<number>("fileSizeLimit") ?? DEFAULTS.fileSizeLimit}`,
    "",
  ].join("\n");
}
