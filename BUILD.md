# BUILD — Autonome build script (Windows)

## Usage
```cmd
build.cmd "feat: add new feature"
```

## What it does
1. Run tests (`holders-health.test.js`, `usdc-filter.test.js`)
2. Lint (optional)
3. Git add + commit with message

## For WSL/Git-Bash
Use `wsl.exe bash -lc 'bash /mnt/c/.../build.sh'` (see SESSION-2026-07-23.md lines 70-71)

## Autonome mode
To avoid permission blocks:
1. Use scripts like this (no inline vars)
2. Pre-approve prefixes: `git commit`, `node test/`, `npm test`
3. Use `require_escalated` with `prefix_rule` in exec_command
