<div align="center">

# YuanHeng Desktop

### Connect YuanHeng API projects to Claude Code, Codex, and other local AI coding tools

[YuanHeng API](https://meta-api.com) · English · [中文](README_ZH.md)

</div>

## Product Direction

YuanHeng Desktop is not a catalog for manually adding and switching API providers.

Providers, API keys, model access, quotas, and billing belong in the YuanHeng API console. The desktop app applies project configuration to local tools and provides local runtime status, project snapshots, MCP, Skills, prompts, and session workflows.

## Workflow

1. Create a project token and configure model access in the [YuanHeng console](https://meta-api.com/console/token).
2. Send the connection configuration from the console to the desktop app, or import an existing local configuration as a migration starting point.
3. Select the target tool and project in the desktop app, then apply the configuration.
4. Continue managing keys, model access, quotas, and usage in the YuanHeng console.

## Current Capabilities

- YuanHeng project connection status and direct console access
- Local configuration application for Claude Code, Claude Desktop, Codex, Gemini CLI, Grok Build, OpenCode, OpenClaw, and Hermes
- Official DSH desktop downloads with Mac chip selection, model configuration and desktop launch ([first-run guide](docs/guides/dsh-first-run.md))
- Project snapshots covering provider configuration, MCP, Skills, prompts, and memory files
- Unified local management for MCP, Skills, prompts, and sessions
- Local routing, protocol conversion, failover, and usage records
- Platform Deep Link delivery and existing-configuration migration

The manual Add Provider and Duplicate Provider flows have been removed. The underlying import path remains available for YuanHeng platform delivery and legacy migration.

## Development

```bash
pnpm install
pnpm dev
```

Checks:

```bash
pnpm typecheck
pnpm test:unit
pnpm build:renderer
```

## Data and Compatibility

- Default configuration directory: `~/.yuanheng-switch/`
- Database, backup, and update protocols remain compatible with existing YuanHeng Switch installations
- Desktop Deep Link scheme: `yuanhengswitch://`

## Attribution and License

This project is maintained by [Raymi Labs](https://github.com/Raymi-Labs/yuanheng-switch), with its earlier releases maintained by `nanashiwang`. Its early codebase was derived from [farion1231/cc-switch](https://github.com/farion1231/cc-switch). The product direction and interaction model now focus on YuanHeng API project integration.

MIT License
