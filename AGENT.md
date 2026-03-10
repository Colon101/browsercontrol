# AGENT.md

## Purpose

BrowserControl is a local-first Firefox extension plus agent server that lets a model control the browser through a single-tool loop.

Current stack:

- `apps/agent`: local Fastify server on `127.0.0.1:4317`
- `apps/extension-firefox`: Firefox extension + overlay UI
- `.vendor/chatmock`: local ChatMock checkout used as the model backend
- `packages/shared`: protocol and shared schemas
- `packages/browser-tools`: tool argument validation and policy helpers
- `packages/model-adapter`: ChatMock-backed tool-calling adapter

The model should receive:

- a screenshot
- a compact visible target map
- minimal state

The model should return:

- exactly one tool call
- or a final answer

## First Places To Read

If you are new, read these first:

1. [README.md](/home/kfir/Documents/browsercontrol/README.md)
2. [apps/agent/src/index.ts](/home/kfir/Documents/browsercontrol/apps/agent/src/index.ts)
3. [apps/extension-firefox/src/background.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/background.ts)
4. [apps/extension-firefox/src/content.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/content.ts)
5. [apps/extension-firefox/src/page-driver.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/page-driver.ts)
6. [packages/shared/src/index.ts](/home/kfir/Documents/browsercontrol/packages/shared/src/index.ts)
7. [packages/model-adapter/src/index.ts](/home/kfir/Documents/browsercontrol/packages/model-adapter/src/index.ts)

If behavior and types disagree, `packages/shared` is usually the source of truth.

## Runtime Map

### Agent

[apps/agent/src/index.ts](/home/kfir/Documents/browsercontrol/apps/agent/src/index.ts) does all of this:

- serves `/health`, `/api/models`, `/api/state`
- serves `/api/model/start`, `/api/model/continue`, `/api/model/message`, `/api/model/cancel`
- serves `/api/runs/next-id`
- serves `/api/extension/runtime`
- persists screenshots into `.data/tasks/run-N/shot-N.png`
- writes per-run logs into `.data/tasks/run-N/run.log`

Important details:

- run IDs are allocated by scanning `.data/tasks` and picking the next `run-N`
- the agent computes runtime bundle versions from bundle checksums
- target maps are logged in compact form

### Firefox Extension

The packaged extension is now mostly a bootstrap.

Key files:

- [apps/extension-firefox/src/background-entry.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/background-entry.ts)
  Background bootstrap loader. It fetches the latest background runtime from the agent, caches it, and reloads when the version changes.
- [apps/extension-firefox/src/remote-background-entry.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/remote-background-entry.ts)
  Real remote background runtime entry.
- [apps/extension-firefox/src/content-entry.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/content-entry.ts)
  Packaged content bootstrap.
- [apps/extension-firefox/src/remote-content-entry.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/remote-content-entry.ts)
  Real remote content runtime entry.
- [apps/extension-firefox/src/background.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/background.ts)
  Session loop, overlay state, screenshot capture, tool execution, model requests.
- [apps/extension-firefox/src/content.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/content.ts)
  Overlay UI, screenshot sanitizing, user-visible click marker.
- [apps/extension-firefox/src/page-driver.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/page-driver.ts)
  DOM target extraction and in-page tool execution.

Important details:

- content and background both hot-update from the agent runtime endpoint
- target IDs are ephemeral and valid only for the latest screenshot/target map
- after every tool call the model must use the refreshed target IDs
- failed tool calls should still return refreshed targets/page state so the model can recover

## Model Loop

The single-tool loop is spread across:

- [packages/model-adapter/src/index.ts](/home/kfir/Documents/browsercontrol/packages/model-adapter/src/index.ts)
- [apps/agent/src/index.ts](/home/kfir/Documents/browsercontrol/apps/agent/src/index.ts)
- [apps/extension-firefox/src/background.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/background.ts)

Flow:

1. Extension captures current page snapshot + target map.
2. Extension captures a screenshot.
3. Agent persists the screenshot and forwards prompt + image to ChatMock.
4. Model returns one tool call or a final answer.
5. Background executes the tool.
6. Extension captures fresh state again.
7. Repeat.

Important detail:

- the ChatMock adapter must preserve assistant tool-call history when sending tool results back
- if you trim message history carelessly, ChatMock can fail with `No tool call found for function call output with call_id ...`

## Targeting And Click Precision

Target extraction logic lives in [apps/extension-firefox/src/page-driver.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/page-driver.ts).

Important current behavior:

- visible semantic controls are preferred
- large generic containers should be filtered out when they are not true click targets
- delegated UIs may be split into child targets so the model sees row-level targets instead of one giant sidebar blob
- `click_coords` is fallback only
- coordinate fallback should resolve to the nearest actionable element and click its center

If the model is missing buttons or clicking the wrong thing, start here first.

## Screenshot Path

Screenshot logic is split between:

- [apps/extension-firefox/src/background.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/background.ts)
- [apps/extension-firefox/src/content.ts](/home/kfir/Documents/browsercontrol/apps/extension-firefox/src/content.ts)

Important current behavior:

- overlay is briefly suppressed for model screenshots
- user-visible click marker exists in the overlay
- marker cleanup should not leak into screenshots
- screenshots are downscaled before sending to the model to avoid `Payload Too Large`

If screenshots look smeared, blocked out, or still contain BrowserControl UI, inspect this path.

## Logging

Console logs:

- `[agent]`: server/session/runtime events
- `[tool]`: model-requested tool calls

Persistent run logs:

- `.data/tasks/run-N/run.log`

If debugging a bad run, inspect:

1. `.data/tasks/run-N/run.log`
2. `.data/tasks/run-N/shot-N.png`
3. console logs from `npm run dev`

## Hot Update Notes

The intended developer workflow is:

- run `npm run dev`
- keep Firefox extension installed
- let agent-served runtime updates refresh background/content code

You should not need repeated extension rebuild/reinstall cycles for normal background/content work once the bootstrap is installed.

Still likely to require reinstall:

- manifest changes
- permissions or CSP changes
- bootstrap entry changes
- icons and packaged metadata

## Tests

Tests live in:

- [tests/model-adapter.spec.ts](/home/kfir/Documents/browsercontrol/tests/model-adapter.spec.ts)
- [tests/page-driver.spec.ts](/home/kfir/Documents/browsercontrol/tests/page-driver.spec.ts)
- [tests/shared.spec.ts](/home/kfir/Documents/browsercontrol/tests/shared.spec.ts)

Run:

- `npm run typecheck`
- `npm test`

If you change model turn handling, target extraction, or schemas, add/update tests in those files.

## Legacy / Suspicious Areas

- Any code path still referring to batch actions is stale and should be treated as suspect.
- If logs show UUID-like session IDs instead of `run-N`, you are probably not running the current bootstrap/runtime.

## External Research

If you need external context, look here first:

- ChatMock local source: [/.vendor/chatmock](/home/kfir/Documents/browsercontrol/.vendor/chatmock)
- ChatMock README: [/.vendor/chatmock/README.md](/home/kfir/Documents/browsercontrol/.vendor/chatmock/README.md)
- Firefox extension manifest/runtime rules: [apps/extension-firefox/manifest.json](/home/kfir/Documents/browsercontrol/apps/extension-firefox/manifest.json)

When investigating a runtime mismatch:

1. compare agent-served runtime version/checksum behavior
2. compare cached runtime in extension storage
3. verify the installed extension is the bootstrap-based one, not an older packaged build

## Practical Debug Order

If something is broken, debug in this order:

1. Check `.data/tasks/run-N/run.log`
2. Check the latest `shot-N.png`
3. Check target extraction in `page-driver.ts`
4. Check model turn handling in `packages/model-adapter`
5. Check agent request/response normalization in `apps/agent/src/index.ts`
6. Check overlay/runtime bootstrap behavior in `background-entry.ts` and `background.ts`
