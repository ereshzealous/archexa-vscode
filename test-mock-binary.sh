#!/bin/bash
# Mock archexa binary for testing the VS Code extension
# Usage: Set archexa.binaryPath to this file's path in VS Code settings

# Print progress events to stderr (JSON)
echo '{"type":"progress","phase":1,"total":3,"label":"Scanning repo","detail":""}' >&2
sleep 0.5
echo '{"type":"progress","phase":2,"total":3,"label":"Investigating","detail":"reading files"}' >&2
sleep 0.5
echo '{"type":"progress","phase":3,"total":3,"label":"Generating","detail":""}' >&2
sleep 0.3

# Print markdown to stdout
echo "## Analysis Result"
echo ""
echo "**Command:** $1"
echo ""
echo "### Summary"
echo ""
echo "This is a mock response for testing the VS Code extension."
echo "The real binary would analyze your codebase here."
echo ""
echo "### Details"
echo ""
echo "- File scanning: working"
echo "- Progress events: working"
echo "- Markdown streaming: working"
echo ""
echo '> All systems operational'

# Print done event to stderr
echo '{"type":"done","duration_ms":1300,"prompt_tokens":500,"completion_tokens":200}' >&2
