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

  const lines: string[] = [
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
  ];

  // Only include custom prompts if non-empty
  // CLI keys: user (= analyze/all), gist, query, impact, review, diagnose
  const promptMap: Array<[string, string]> = [
    ["diagnose", "promptDiagnose"],
    ["review", "promptReview"],
    ["query", "promptQuery"],
    ["impact", "promptImpact"],
    ["gist", "promptGist"],
    ["user", "promptAnalyze"],  // CLI "user" prompt = analyze/all commands
  ];
  const prompts: Array<[string, string]> = [];
  for (const [cliKey, settingKey] of promptMap) {
    const val = cfg.get<string>(settingKey)?.trim();
    if (val) prompts.push([cliKey, val]);
  }
  if (prompts.length > 0) {
    lines.push("  prompts:");
    for (const [cmd, text] of prompts) {
      lines.push(`    ${cmd}: |`);
      for (const pLine of text.split("\n")) {
        lines.push(`      ${pLine}`);
      }
    }
  }

  // Review default target
  const reviewTarget = cfg.get<string>("reviewTarget")?.trim();
  if (reviewTarget) {
    lines.push("  review:");
    lines.push(`    target: "${reviewTarget}"`);
  }

  // Scan focus directories
  const scanFocus = cfg.get<string[]>("scanFocus") ?? [];
  if (scanFocus.length > 0) {
    lines.push("  scan_focus:");
    for (const dir of scanFocus) {
      lines.push(`    - "${dir}"`);
    }
  }

  // Exclude patterns — merge defaults with user-configured patterns
  const defaultExcludePatterns = [".archexa/**", ".archexa_cache/**", "generated/**"];
  const userPatterns = cfg.get<string[]>("excludePatterns") ?? [];
  const allPatterns = [...new Set([...defaultExcludePatterns, ...userPatterns])];
  if (allPatterns.length > 0) {
    lines.push("  exclude_patterns:");
    for (const pat of allPatterns) {
      lines.push(`    - "${pat}"`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
