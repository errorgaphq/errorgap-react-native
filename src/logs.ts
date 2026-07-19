export function normalizeLogLevel(level: string): string {
  switch (level.trim().toLowerCase()) {
    case "warning":
    case "warn":
      return "warn";
    case "err":
    case "severe":
      return "error";
    case "fine":
    case "finer":
    case "finest":
      return "debug";
    case "trace":
    case "debug":
    case "info":
    case "error":
    case "fatal":
      return level.trim().toLowerCase();
    default:
      return "info";
  }
}

export function logLevelRank(level: string): number {
  switch (level) {
    case "trace":
      return 0;
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
    case "fatal":
      return 50;
    default:
      return 20;
  }
}
