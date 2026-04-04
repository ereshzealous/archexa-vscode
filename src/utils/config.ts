import * as vscode from "vscode";

/**
 * Escape a string for safe inclusion in a YAML double-quoted scalar.
 * Handles: backslash, double-quote, newline, carriage return, tab.
 */
function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

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
    `    model: "${yamlEscape(cfg.get<string>("model") ?? DEFAULTS.model)}"`,
    `    endpoint: "${yamlEscape(cfg.get<string>("endpoint") ?? DEFAULTS.endpoint)}"`,
    `    tls_verify: ${cfg.get<boolean>("tlsVerify") ?? DEFAULTS.tlsVerify}`,
    "  deep:",
    `    enabled: ${cfg.get<boolean>("deepByDefault") ?? DEFAULTS.deepByDefault}`,
    `    max_iterations: ${Number(cfg.get<number>("deepMaxIterations") ?? DEFAULTS.deepMaxIterations)}`,
    `  cache: ${cfg.get<boolean>("cacheEnabled") ?? DEFAULTS.cacheEnabled}`,
    `  output: "${yamlEscape(cfg.get<string>("outputDir") ?? DEFAULTS.outputDir)}"`,
    `  log_level: "${yamlEscape(cfg.get<string>("logLevel") ?? DEFAULTS.logLevel)}"`,
    "  limits:",
    `    max_files: ${Number(cfg.get<number>("maxFiles") ?? DEFAULTS.maxFiles)}`,
    `    prompt_budget: ${Number(cfg.get<number>("promptBudget") ?? DEFAULTS.promptBudget)}`,
    `    prompt_reserve: ${Number(cfg.get<number>("promptReserve") ?? DEFAULTS.promptReserve)}`,
    "  evidence:",
    `    file_size_limit: ${Number(cfg.get<number>("fileSizeLimit") ?? DEFAULTS.fileSizeLimit)}`,
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
    lines.push(`    target: "${yamlEscape(reviewTarget)}"`);
  }

  // Scan focus directories
  const scanFocus = cfg.get<string[]>("scanFocus") ?? [];
  if (scanFocus.length > 0) {
    lines.push("  scan_focus:");
    for (const dir of scanFocus) {
      lines.push(`    - "${yamlEscape(dir)}"`);
    }
  }

  // Exclude patterns — merge defaults with user-configured patterns
  const defaultExcludePatterns = [".archexa/**", ".archexa_cache/**", "generated/**"];
  const userPatterns = cfg.get<string[]>("excludePatterns") ?? [];
  const allPatterns = [...new Set([...defaultExcludePatterns, ...userPatterns])];
  if (allPatterns.length > 0) {
    lines.push("  exclude_patterns:");
    for (const pat of allPatterns) {
      lines.push(`    - "${yamlEscape(pat)}"`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
