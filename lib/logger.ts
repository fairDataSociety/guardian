export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {}
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

export function logInfo(msg: string, fields?: Record<string, unknown>): void {
  log("info", msg, fields);
}

export function logWarn(msg: string, fields?: Record<string, unknown>): void {
  log("warn", msg, fields);
}

export function logError(msg: string, fields?: Record<string, unknown>): void {
  log("error", msg, fields);
}
