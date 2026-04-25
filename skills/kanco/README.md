# kanco skill

A Claude Agent skill that teaches an LLM how to drive its own work across a
[kanco](../../README.md) board via the kanco MCP server.

The skill instructs the agent to:

- Create a Todo ticket as soon as it accepts a task
- Move the ticket to Planning while it scopes and designs
- Move to In Progress when it starts writing code
- Split parallel streams of work into subtasks
- Link the PR as soon as it is opened, then let kanco auto-move the ticket
  to In Review (open PR) and Done (merged PR) based on GitHub state

## Install

### With the `skills` CLI (recommended)

```sh
npx skills add jshthornton/kanco --skill kanco
```

Works with Claude Code, Cursor, Windsurf, and other agents that follow the
open Agent Skills layout.

### Or ask your agent

> "Install the kanco skill from github.com/jshthornton/kanco."

### Manual

```sh
mkdir -p ~/.claude/skills
cp -r skills/kanco ~/.claude/skills/
```

Then add the kanco MCP endpoint:

```sh
claude mcp add kanco http://localhost:8787/mcp --transport http
```

### Other agents

The skill is a single `SKILL.md` file with YAML frontmatter — copy it into
whatever skill / system-prompt mechanism your agent supports.
