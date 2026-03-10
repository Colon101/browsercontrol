# BrowserControl

Local-first Firefox browser control harness with a ChatMock-backed decision loop.

## What exists now

- Local agent server on `127.0.0.1:4317`
- Firefox extension with injected overlay UI
- Server-backed extension runtime updates for the overlay/content layer
- ChatMock-backed model adapter that drives one tool call at a time
- Shared schemas, tool validation, policy checks, and task loop persistence
- Extension build that emits a Firefox-ready zip

## Install

```bash
npm install
```

Set the ChatMock base URL before starting the agent:

```bash
export BROWSERCONTROL_CHATMOCK_BASE_URL=http://127.0.0.1:8000
```

## Run the local agent

```bash
npm run build:settings
npm run dev
```

The debug page is served at `http://127.0.0.1:4317/`.

Run the focused test suite with:

```bash
npm test
```

## Build and package the Firefox extension

```bash
npm run build:extension
```

This produces:

- `apps/extension-firefox/dist/`
- `apps/extension-firefox/build/browsercontrol-firefox.zip`

Load the zip contents in Firefox with `about:debugging` -> `This Firefox` -> `Load Temporary Add-on`, or unzip it first and point Firefox at `manifest.json`.

## Runtime updates without rebuilding the zip

After the extension is installed once, the packaged add-on now acts as a bootstrap:

- On startup and before reinjection, the background script asks the local agent server for the latest extension runtime bundle.
- The bundle is cached in `storage.local` and reused if the server is temporarily unavailable.
- Overlay/content changes in `apps/extension-firefox/src/` and `apps/extension-firefox/assets/overlay.css` are served directly by the agent, so normal iteration no longer requires `npm run build:extension`.

## Runtime model flow

- The model receives a screenshot plus a compact target map for visible interactive elements.
- The model issues one tool call at a time, such as `click_target`, `type_target`, or `go_back`.
- After each interaction, BrowserControl captures a clean screenshot with the injected UI hidden and returns the refreshed target map.

What still requires a rebuild:

- `manifest.json`
- the packaged bootstrap entrypoints
- toolbar icons and other packaged metadata

## Icon source

The robot icon was sourced from Lucide's `bot.svg` icon:

- https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/bot.svg
