---
name: verify-pi-auto-router
description: Verify shared-session routing lifecycle through registered extension hooks with real Pi contexts and an offline provider.
---

# Verify session lifecycle

The primary surface is the Pi extension in `index.ts`, loaded once and shared by
in-process sessions. Other surfaces include `/auto-router` commands, provider
streaming, route snapshots, and JSONL event logs. This recipe covers lifecycle
and model-resolution errors; it does not verify interactive UI or live providers.

Run from the repository root. Read repository instructions first. Record
`git rev-parse HEAD`, `node --version`, and `npm ls --depth=0` in proof outside the
repository. Dependencies must match `package-lock.json`; use `npm ci
--ignore-scripts` only if installation is needed. No credentials are required.

Read-only doctor: `npm run check`. An exit of zero establishes type readiness;
the lifecycle test additionally requires a custom-provider request to return
`stop` through the registered provider callback, not merely load the module.

Drive: `node --import tsx --test tests/session-lifecycle.test.ts`.
Retain stdout/stderr and exit status outside the checkout. The test drives the
actual extension's registered session hooks with Pi `ExtensionRunner` contexts,
real in-memory `SessionManager`s, a fake model registry, and an offline transport.
It creates a unique temporary home, configures one custom-model route and one
missing-model route, then verifies:

| User journey | Action/result assertion |
| --- | --- |
| Parent continues after child exits | start parent/child, route child, shut child down, route parent; parent succeeds and child's snapshot disappears |
| Missing route target | route missing model; error lists the registry's custom provider |
| Disposal without shutdown | end parent, invalidate orphan, run next event; snapshot disappears and adapter unregisters |
| Start another session | session_start, route; adapter re-registers and request succeeds |

The test disables UVI, redirects `os.homedir()` before importing the extension,
and waits (at most five seconds) for each persisted `routing.final` event after
terminal responses before shutdown or cleanup.
It neither reads real auth storage nor calls a provider. It simulates disposal by
invalidating a runner; it does not reproduce a real pi-subagents timeout.
Cleanup is lazy until another tracker operation. Session attribution remains the
most recent session event unless stream options supply a session ID.

The test restores process settings and removes only its unique temporary home
in `finally`, including on assertion failure. For a cleanup audit use
`TMPDIR=<owned scratch directory>` and compare its contents before/after; preserve
proof elsewhere. Run twice (or concurrently with separate scratch directories)
when changing isolation. Never delete another run's home or stop shared Pi.
Read the saved log after cleanup and require exit zero and one passing test.

Full regression tests also need HOME and `os.homedir()` redirected because older
tracker tests write under `.pi`. Keep that runner-specific preload in task proof,
not user configuration. Changes to this harness or lifecycle require independent
review and new execution evidence. Real provider/network behavior, interactive
commands, concurrent in-flight shutdown, and real subagent timeout remain
uncovered by this offline recipe.
