/**
 * Shared HTML security and rendering utilities for Archexa webviews.
 *
 * - escapeHtml:      sanitize dynamic values before interpolation into HTML template strings
 * - configureMarked: disable raw HTML output from marked to prevent XSS from CLI/model output
 * - linkifyFileRefs: make file:line references clickable in rendered HTML
 */

import { marked } from "marked";

/** Escape HTML special characters to prevent XSS in template literal interpolation. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Configure marked globally to block raw HTML in markdown output.
 * Any `<tag>` in the CLI/model output is escaped rather than passed through.
 * Must be called once at module load time.
 */
export function configureMarked(): void {
  marked.use({
    renderer: {
      // Escape raw HTML blocks instead of rendering them
      html(token: { text: string } | string) {
        return escapeHtml(typeof token === "string" ? token : token.text);
      },
    },
  });
}

// Auto-configure on import
configureMarked();

/** Known source file extensions for file:line linkification */
const FILE_EXTS = "py|ts|tsx|js|jsx|go|java|rs|rb|cs|kt|cpp|c|h|hpp|php|yaml|yml|json|md|toml|cfg|ini|sh|bash|sql|html|css|scss|xml|proto|graphql|tf|hcl";

/**
 * Post-process rendered HTML to make file:line references clickable.
 * Matches patterns like `src/foo.py:42` or `api/auth.py:7`.
 */
export function linkifyFileRefs(html: string): string {
  const pattern = new RegExp(
    `(?<!\\/\\/)(?:^|(?<=[ \\t(>"'\`]))` +
    `([\\w./@-]+\\.(?:${FILE_EXTS})):(\\d+)` +
    `(?=[ \\t)<"'\`,;]|$)`,
    "gm"
  );
  return html.replace(pattern, (_match, filePath: string, line: string) => {
    const escaped = escapeHtml(filePath);
    return `<a class="file-link" data-file="${escaped}" data-line="${line}" title="Open ${escaped}:${line}">${escaped}:${line}</a>`;
  });
}
