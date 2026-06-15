export interface BacktraceFrame {
  file?: string;
  line?: number;
  function?: string;
  in_app?: boolean;
  index: number;
}

const V8_AT = /^\s*at\s+(?:(.*?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/;
const HERMES_AT = /^(?:(.*?)@)?(.+?)(?::(\d+))?(?::(\d+))?$/;

/** Parse a V8-style or Hermes/Safari-style stack trace into Errorgap frames. */
export function parseBacktrace(error: Error): BacktraceFrame[] {
  const stack = typeof error.stack === "string" ? error.stack : "";
  if (!stack) return [];

  const lines = stack.split("\n");
  const frames: BacktraceFrame[] = [];
  let index = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Error") || trimmed.endsWith(":")) continue;

    const parsed = parseLine(trimmed);
    if (!parsed) continue;
    const [fnName, location, lineNumber] = parsed;
    frames.push({
      file: location,
      line: lineNumber,
      function: fnName,
      in_app: isInApp(location),
      index: index++,
    });
  }

  return frames;
}

function parseLine(line: string): [string | undefined, string, number | undefined] | null {
  if (line.startsWith("at ")) {
    const m = line.match(V8_AT);
    if (!m) return null;
    return [m[1] || undefined, m[2] ?? "", m[3] ? Number(m[3]) : undefined];
  }
  const m = line.match(HERMES_AT);
  if (!m) return null;
  return [m[1] || undefined, m[2] ?? "", m[3] ? Number(m[3]) : undefined];
}

function isInApp(file: string): boolean {
  if (!file) return false;
  if (file.includes("node_modules")) return false;
  if (file.includes("/InternalBytecode/")) return false; // Hermes internal
  if (file.startsWith("[native")) return false;
  return true;
}
