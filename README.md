# claude-plugins

Nikolai's [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```text
/plugin marketplace add NTillmann/claude-plugins
/plugin install forge@claude-plugins
```

`/plugin marketplace update` pulls the latest after changes are pushed here.

## Plugins

### forge

Plan → implement → polish → ship a task end-to-end (autonomous, multi-repo), with a
durable plan queue. Ships a driver command (`/forge`) plus the orchestration workflow it
runs. The command invokes the workflow **by path** out of the plugin directory
(`${CLAUDE_PLUGIN_ROOT}/workflow/forge.js`), so no separate workflow install step is
needed — it works the moment the plugin is installed.

- `/forge <task or plan-file>` — run one task through plan/build/ship.
- `/forge queue` — drain a durable queue of plans, one at a time.
- `/forge enqueue <task or plan-file>` — add to the queue without executing.
