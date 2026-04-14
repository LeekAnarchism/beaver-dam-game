#!/bin/bash
set -euo pipefail

# Read the JSON input from stdin
INPUT=$(cat)

# Extract the prompt text from the hook payload
PROMPT=$(echo "$INPUT" | jq -r '.prompt // "No prompt captured"')

# Only commit if there are staged/unstaged changes
if git diff --quiet && git diff --cached --quiet; then
  exit 0
fi

# Stage all changes
git add -A

# Build commit message: summary line + full prompt in body
SUMMARY=$(echo "$PROMPT" | head -c 72 | tr '\n' ' ')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

git commit -m "claude: $SUMMARY" -m "Prompt ($TIMESTAMP):
$PROMPT"
