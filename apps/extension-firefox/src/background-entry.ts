export {};

const AGENT_HTTP = "http://127.0.0.1:4317";
const BACKGROUND_RUNTIME_STORAGE_KEY = "background-runtime-v1";
const BACKGROUND_RUNTIME_REFRESH_MS = 2000;

type ExtensionApi = {
  runtime: {
    getURL(path: string): string;
  };
  storage?: {
    local?: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
};

type BackgroundRuntimePayload = {
  ok: true;
  version: string;
  generatedAt: string;
  backgroundScript: string;
};

declare global {
  var __browsercontrolBackgroundBootstrapPromise: Promise<void> | undefined;
  var __browsercontrolBackgroundRuntimeVersion: string | undefined;
}

const ext = getExtensionApi();
const backgroundGlobals = globalThis as typeof globalThis & {
  __browsercontrolBackgroundBootstrapPromise?: Promise<void>;
  __browsercontrolBackgroundRuntimeVersion?: string;
};

backgroundGlobals.__browsercontrolBackgroundBootstrapPromise ??= boot();

async function boot() {
  const runtime = await resolveBackgroundRuntime();
  if (runtime) {
    backgroundGlobals.__browsercontrolBackgroundRuntimeVersion = runtime.version;
    await loadRuntimeModule(runtime.backgroundScript);
  } else {
    backgroundGlobals.__browsercontrolBackgroundRuntimeVersion = "packaged";
    await import(ext.runtime.getURL("background-runtime.js"));
  }
  scheduleRuntimeRefresh();
}

async function resolveBackgroundRuntime() {
  const cached = await readStoredRuntime();
  try {
    const response = await fetch(`${AGENT_HTTP}/api/extension/runtime`);
    if (!response.ok) {
      throw new Error(`runtime responded with ${response.status}`);
    }
    const payload = parseBackgroundRuntimePayload(await response.json());
    await storeRuntime(payload);
    return payload;
  } catch {
    return cached;
  }
}

function scheduleRuntimeRefresh() {
  setInterval(() => {
    void refreshRuntimeVersion();
  }, BACKGROUND_RUNTIME_REFRESH_MS);
}

async function refreshRuntimeVersion() {
  try {
    const response = await fetch(`${AGENT_HTTP}/api/extension/runtime`);
    if (!response.ok) {
      return;
    }
    const payload = parseBackgroundRuntimePayload(await response.json());
    await storeRuntime(payload);
    if (payload.version !== backgroundGlobals.__browsercontrolBackgroundRuntimeVersion) {
      location.reload();
    }
  } catch {
    return;
  }
}

async function readStoredRuntime() {
  if (!ext.storage?.local) {
    return null;
  }

  try {
    const stored = await ext.storage.local.get(BACKGROUND_RUNTIME_STORAGE_KEY);
    return parseStoredRuntime(stored[BACKGROUND_RUNTIME_STORAGE_KEY] as Record<string, unknown> | undefined);
  } catch {
    return null;
  }
}

async function storeRuntime(runtime: BackgroundRuntimePayload) {
  if (!ext.storage?.local) {
    return;
  }

  await ext.storage.local.set({
    [BACKGROUND_RUNTIME_STORAGE_KEY]: runtime
  });
}

async function loadRuntimeModule(code: string) {
  const url = URL.createObjectURL(
    new Blob([code], {
      type: "text/javascript"
    })
  );

  try {
    await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseBackgroundRuntimePayload(payload: unknown): BackgroundRuntimePayload {
  const record = payload as Record<string, unknown> | null;
  if (
    !record ||
    record.ok !== true ||
    typeof record.version !== "string" ||
    typeof record.generatedAt !== "string" ||
    typeof record.backgroundScript !== "string"
  ) {
    throw new Error("Invalid background runtime payload.");
  }

  return {
    ok: true,
    version: record.version,
    generatedAt: record.generatedAt,
    backgroundScript: record.backgroundScript
  };
}

function parseStoredRuntime(payload: Record<string, unknown> | undefined) {
  if (
    !payload ||
    typeof payload.version !== "string" ||
    typeof payload.generatedAt !== "string" ||
    typeof payload.backgroundScript !== "string"
  ) {
    return null;
  }

  return {
    ok: true,
    version: payload.version,
    generatedAt: payload.generatedAt,
    backgroundScript: payload.backgroundScript
  } satisfies BackgroundRuntimePayload;
}

function getExtensionApi(): ExtensionApi {
  const globalRecord = globalThis as Record<string, unknown>;
  const candidate = globalRecord.browser ?? globalRecord.chrome;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Browser extension API is unavailable.");
  }
  return candidate as ExtensionApi;
}
