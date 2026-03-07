# BrowserControl

Local-first Firefox browser control harness with a Codex-backed decision loop.

## What exists now

- Local agent server on `127.0.0.1:4317`
- Firefox extension with injected overlay UI
- Codex CLI adapter that can drive tool-by-tool browser workflows
- Shared schemas, tool validation, policy checks, and task loop persistence
- Extension build that emits a Firefox-ready zip

## Install

```bash
npm install
```

If you want the Codex subscription path, log into the CLI first:

```bash
npx @openai/codex login
```

## Run the local agent

```bash
npm run build:settings
npm run dev
```

The debug page is served at `http://127.0.0.1:4317/`.

## Build and package the Firefox extension

```bash
npm run build:extension
```

This produces:

- `apps/extension-firefox/dist/`
- `apps/extension-firefox/build/browsercontrol-firefox.zip`

Load the zip contents in Firefox with `about:debugging` -> `This Firefox` -> `Load Temporary Add-on`, or unzip it first and point Firefox at `manifest.json`.

## Icon source

The robot icon was sourced from Lucide's `bot.svg` icon:

- https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/bot.svg
