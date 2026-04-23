# pi-auto-router

A subscription-first automatic model/provider failover extension for [pi coding agent](https://github.com/badlogic/pi-mono).

It exposes a custom provider with opinionated routing profiles:

- `auto-router/subscription-premium`
- `auto-router/subscription-coding`
- `auto-router/subscription-fast`

Unlike a simple model switcher, `auto-router` can retry the **same request** across a configured route chain when a provider hits retryable failures like rate limits, temporary overload, or transient network/server errors.

## Highlights

- **Subscription-first routing** across multiple providers
- **Same-request failover** before substantive output starts
- **Cooldown tracking** for temporarily failing providers/models
- **External JSON config** for route definitions and aliases
- **Richer operator commands** for status, route inspection, search, aliases, and reloads

## Install

### From GitHub

```bash
pi install git:github.com/danialranjha/pi-auto-router
```

### Update

To update to the latest version from GitHub:

```bash
pi update git:github.com/danialranjha/pi-auto-router
```

Alternatively, if you are developing locally:

```bash
cd /path/to/pi-auto-router
git pull
npm install
npm run build
```

Then reload the extension inside pi:

```text
/auto-router reload
```

### Try without installing

```bash
pi -e git:github.com/danialranjha/pi-auto-router
```

## Quick start

1. Install the package
2. Reload pi with `/reload`
3. Open `/model`
4. Select one of:
   - `auto-router/subscription-premium`
   - `auto-router/subscription-coding`
   - `auto-router/subscription-fast`
5. Inspect routing with:

```text
/auto-router list
```

## Config file

`auto-router` reads its config from:

```text
~/.pi/agent/extensions/auto-router.routes.json
```

If the file is missing or invalid, it falls back to built-in defaults.

A starter config is included in the repo as:

```text
auto-router.routes.example.json
```

Copy it into place and customize:

```bash
mkdir -p ~/.pi/agent/extensions
cp auto-router.routes.example.json ~/.pi/agent/extensions/auto-router.routes.json
```

## Example config

```json
{
  "routes": {
    "subscription-premium": {
      "name": "Subscription Premium Router",
      "reasoning": true,
      "input": ["text", "image"],
      "targets": [
        {
          "provider": "claude-agent-sdk",
          "modelId": "claude-opus-4-6",
          "label": "Claude Opus 4.6 via Claude Code"
        },
        {
          "provider": "google-antigravity",
          "modelId": "gemini-3.1-pro-high",
          "authProvider": "google-antigravity",
          "label": "Gemini 3.1 Pro"
        },
        {
          "provider": "openai-codex",
          "modelId": "gpt-5.4",
          "authProvider": "openai-codex",
          "label": "GPT-5.4"
        },
        {
          "provider": "ollama",
          "modelId": "glm-5.1:cloud",
          "label": "GLM-5.1 via Ollama Cloud Subscription"
        }
      ]
    }
  },
  "aliases": {
    "premium": ["auto-router/subscription-premium"],
    "claude": [
      "claude-agent-sdk/claude-opus-4-6",
      "claude-agent-sdk/claude-opus-4-5"
    ]
  }
}
```

## Target fields

Each route target supports:

- `provider` — pi provider id
- `modelId` — model id under that provider
- `label` — human-readable label
- `authProvider` — optional auth provider lookup in `~/.pi/agent/auth.json`

Use `authProvider` for providers whose OAuth/access token should be read from pi auth storage.
Skip it for providers that authenticate internally or don’t require pi-managed tokens for the request path.

## Commands

`auto-router` registers:

- `/auto-router`
- `/auto-router status`
- `/auto-router switch <route|alias|provider/model>`
- `/auto-router list`
- `/auto-router show <routeId>`
- `/auto-router search <query>`
- `/auto-router aliases`
- `/auto-router resolve <alias>`
- `/auto-router models`
- `/auto-router reload`
- `/auto-router reset`

### Example operator flows

```text
/auto-router switch premium
/auto-router switch claude
/auto-router switch subscription-fast
/auto-router list
/auto-router show subscription-premium
/auto-router search gemini
/auto-router aliases
/auto-router resolve premium
/auto-router reload
```

## Behavior notes

- Only **retryable** errors trigger automatic failover
- Route targets that can’t be resolved from the registry are also treated as failoverable so the chain can keep moving
- Failover happens only **before substantive output starts**
- Once a provider/model emits real content, the router stays on that target
- Retryable failures put the target on a temporary cooldown
- Cooldowns are currently in-memory and reset on pi reload/restart

## Default routes

The repository ships with opinionated defaults oriented around subscription-backed providers plus Ollama Cloud fallback:

- Claude Code via `claude-agent-sdk`
- OpenAI Codex
- Google Antigravity
- NVIDIA DeepSeek (`deepseek-ai/deepseek-v3.2`)
- Ollama Cloud (`glm-5.1:cloud`)

You should edit `~/.pi/agent/extensions/auto-router.routes.json` to match your own environment.

## Development

To try locally without installing globally:

```bash
pi -e /absolute/path/to/auto-router
```

## License

MIT
