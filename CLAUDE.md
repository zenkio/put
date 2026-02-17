# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in Apple Container (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: WhatsApp connection, message routing, IPC |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Operational Patterns

### Scout/Surgeon Pattern

To enhance efficiency and leverage specialized model strengths, NanoClaw now employs a Scout/Surgeon pattern for complex tasks:

*   **Scout (Gemini 2.5 Flash - Simulated):** Responsible for initial analysis, file indexing, and drafting. This involves identifying relevant files, understanding context, and generating preliminary outlines or refactoring suggestions. The Scout's output is then passed to the Surgeon for implementation.
    *   **Identified Logic for Scout Indexing/Drafting:**
        *   Centralized File I/O (e.g., `src/utils.ts`, `src/container-runner.ts`, `src/index.ts`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp.ts`, `.claude/skills/x-integration/agent.ts`, `.claude/skills/x-integration/host.ts`, `.claude/skills/x-integration/scripts/setup.ts` for `fs.readFileSync`/`fs.writeFileSync` operations).
        *   Content Drafting (e.g., `src/mount-security.ts` for `generateAllowlistTemplate`, `src/index.ts` for dynamic `CLAUDE.md` content, `container/agent-runner/src/index.ts` for markdown generation).
*   **Surgeon (Claude - Simulated):** Responsible for implementing the final changes based on the Scout's analysis and drafts. This includes modifying configuration files, updating `CLAUDE.md`, and making other code alterations.

### Integration Logic: WhatsApp Request Context

For every new WhatsApp request, **always call `zen:analyze` first to get context before writing any code.** This ensures the agent has the most up-to-date understanding of the codebase and user intent.

### Quota Guard: Claude Fallback

If the Claude quota is nearly empty, the entire decision-making process must be routed to `zen:chat` using Gemini 2.5 Flash. This serves as a fallback mechanism to ensure continuous operation.


