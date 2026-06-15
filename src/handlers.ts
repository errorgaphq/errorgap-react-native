import type { Client } from "./client.js";

interface ErrorUtilsLike {
  setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
  getGlobalHandler(): ((error: Error, isFatal?: boolean) => void) | undefined;
}

let installed = false;
let previousErrorUtilsHandler: ((error: Error, isFatal?: boolean) => void) | undefined;
let rejectionHandler: ((reason: unknown) => void) | null = null;

/**
 * Hook React Native's `ErrorUtils.setGlobalHandler` (the JS-side
 * unhandled error mechanism) plus the Promise rejection tracker.
 *
 * Safe to call from non-RN environments: the function feature-detects
 * `ErrorUtils` on the global object and silently skips when missing.
 */
export function installGlobalHandlers(client: Client): void {
  if (installed) return;
  installed = true;

  const errorUtils = getErrorUtils();
  if (errorUtils) {
    previousErrorUtilsHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      void client.notify(error, {
        sync: true,
        context: { source: "ErrorUtils.setGlobalHandler" },
        isFatal,
      });
      previousErrorUtilsHandler?.(error, isFatal);
    });
  }

  rejectionHandler = (reason: unknown) => {
    void client.notify(reason, {
      context: { source: "unhandledrejection" },
    });
  };
  // RN polyfills `process` in some environments; node/jest envs also have it.
  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("unhandledRejection", rejectionHandler);
  }
}

export function uninstallGlobalHandlers(): void {
  if (!installed) return;
  const errorUtils = getErrorUtils();
  if (errorUtils && previousErrorUtilsHandler) {
    errorUtils.setGlobalHandler(previousErrorUtilsHandler);
  }
  if (rejectionHandler && typeof process !== "undefined" && typeof process.off === "function") {
    process.off("unhandledRejection", rejectionHandler);
  }
  previousErrorUtilsHandler = undefined;
  rejectionHandler = null;
  installed = false;
}

function getErrorUtils(): ErrorUtilsLike | undefined {
  // React Native exposes ErrorUtils on the global; in non-RN environments
  // (tests, Node) it's absent.
  const candidate = (globalThis as Record<string, unknown>).ErrorUtils;
  if (candidate && typeof candidate === "object" &&
      "setGlobalHandler" in candidate && "getGlobalHandler" in candidate) {
    return candidate as ErrorUtilsLike;
  }
  return undefined;
}
