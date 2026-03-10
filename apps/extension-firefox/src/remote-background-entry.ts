import { bootBackground } from "./background.js";

declare global {
  var __browsercontrolBackgroundRuntimeBooted: boolean | undefined;
}

if (!globalThis.__browsercontrolBackgroundRuntimeBooted) {
  globalThis.__browsercontrolBackgroundRuntimeBooted = true;
  bootBackground();
}
