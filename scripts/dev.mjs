import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, ".vendor", "chatmock");
const venvDir = join(vendorDir, ".venv");
const pythonBin =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
const chatmockEntry = join(vendorDir, "chatmock.py");
const chatmockBaseUrl = process.env.BROWSERCONTROL_CHATMOCK_BASE_URL ?? "http://127.0.0.1:8000";
const chatmockModelsUrl = `${chatmockBaseUrl.replace(/\/$/, "")}/v1/models`;

buildExtension();
ensureChatMockRepo();

ensureVirtualenv();
ensurePythonDeps();
await ensureChatMockLogin();

let chatmockProcess = null;
if (!(await isChatMockReady())) {
  chatmockProcess = spawn(pythonBin, [
    chatmockEntry,
    "serve",
    "--reasoning-effort",
    process.env.BROWSERCONTROL_CHATMOCK_REASONING_EFFORT ?? "low",
    "--reasoning-summary",
    process.env.BROWSERCONTROL_CHATMOCK_REASONING_SUMMARY ?? "none"
  ], {
    cwd: vendorDir,
    stdio: "inherit"
  });
  const ready = await waitForChatMock(20_000);
  if (!ready) {
    console.error(`ChatMock did not become ready at ${chatmockModelsUrl}.`);
    chatmockProcess.kill("SIGTERM");
    process.exit(1);
  }
}

const agentProcess = spawn(
  process.execPath,
  ["--import", "tsx", join(root, "apps", "agent", "src", "index.ts")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      BROWSERCONTROL_CHATMOCK_BASE_URL: chatmockBaseUrl
    }
  }
);

const shutdown = (code = 0) => {
  if (agentProcess.exitCode === null) {
    agentProcess.kill("SIGTERM");
  }
  if (chatmockProcess && chatmockProcess.exitCode === null) {
    chatmockProcess.kill("SIGTERM");
  }
  process.exitCode = code;
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

agentProcess.on("exit", (code) => {
  if (chatmockProcess && chatmockProcess.exitCode === null) {
    chatmockProcess.kill("SIGTERM");
  }
  process.exit(code ?? 0);
});

if (chatmockProcess) {
  chatmockProcess.on("exit", async (code) => {
    if (agentProcess.exitCode === null) {
      agentProcess.kill("SIGTERM");
    }
    if (code && !(await isChatMockReady())) {
      process.exit(code);
    }
  });
}

function ensureVirtualenv() {
  if (existsSync(pythonBin)) {
    return;
  }
  const result = spawnSync("python3", ["-m", "venv", venvDir], {
    cwd: vendorDir,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildExtension() {
  const result = spawnSync(process.execPath, [join(root, "apps", "extension-firefox", "build.mjs")], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureChatMockRepo() {
  if (existsSync(vendorDir) && existsSync(chatmockEntry)) {
    return;
  }
  const result = spawnSync(
    "git",
    ["clone", "https://github.com/RayBytes/ChatMock.git", vendorDir],
    {
      cwd: root,
      stdio: "inherit"
    }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensurePythonDeps() {
  const result = spawnSync(
    pythonBin,
    [
      "-c",
      "import flask, requests"
    ],
    {
      cwd: vendorDir,
      stdio: "ignore"
    }
  );
  if (result.status === 0) {
    return;
  }

  const install = spawnSync(
    pythonBin,
    ["-m", "pip", "install", "-r", "requirements.txt"],
    {
      cwd: vendorDir,
      stdio: "inherit"
    }
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

async function ensureChatMockLogin() {
  const result = spawnSync(pythonBin, [chatmockEntry, "info"], {
    cwd: vendorDir,
    stdio: "ignore"
  });
  if (result.status === 0) {
    return;
  }

  const login = spawnSync(pythonBin, [chatmockEntry, "login"], {
    cwd: vendorDir,
    stdio: "inherit"
  });
  if (login.status !== 0) {
    process.exit(login.status ?? 1);
  }
}

async function waitForChatMock(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isChatMockReady()) {
      return true;
    }
    await delay(250);
  }
  return false;
}

async function isChatMockReady() {
  try {
    const response = await fetch(chatmockModelsUrl, {
      headers: {
        Authorization: "Bearer key"
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
