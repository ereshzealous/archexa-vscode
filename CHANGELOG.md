# Changelog

## [0.1.0] - 2026-04-04

### Added
- Unified sidebar with chat, settings, and history in a single webview
- Two-step command wizard: grouped slash menu + per-command input forms
- Six AI commands: Review, Diagnose, Impact, Query, Gist, Analyze
- Explain This (right-click selection)
- Real-time streaming output with live agent step display
- File autocomplete with `git ls-files` integration
- Collapsible chat history with accordion UI
- Settings panel with Connect, Behaviour, Prompts, and Advanced tabs
- Inline review findings as editor squiggles (VS Code Problems panel)
- Auto-download binary from GitHub Releases with SHA256 verification
- Connection test (sends real chat/completions request)
- Welcome page with feature overview and getting started guide
- Onboarding setup wizard for first-time installation
- Copy/Save toolbar on all results
- Investigation details (agent steps) expandable per result
- Multi-file review and impact analysis (explorer multi-select)
- Review uncommitted changes and branch diffs
- Custom prompts per command
- Exclude patterns and scan focus configuration
- Auto-sync settings to `archexa.yaml`
- History with date groups (Today, Yesterday, etc.)
- Platform-aware keyboard shortcuts (Cmd on macOS, Ctrl on Windows/Linux)

### Security
- XSS prevention: marked configured to block raw HTML, inline `esc()` for all dynamic values
- Shell injection prevention: `execFileSync` instead of `execSync`
- API key never sent to webview (masked display only)
- YAML injection prevention: proper escaping in config generation
- Binary downloads restricted to HTTPS GitHub CDN hosts only
- SHA256 checksum verification for downloaded binaries

### Supported Platforms
- macOS (Apple Silicon, Intel)
- Linux (x86_64, arm64)
- Windows (x64)
