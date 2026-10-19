/** Tiny structured logger — no deps, colour only when a TTY is attached. */
const useColor = process.stdout.isTTY;
const wrap = (code: string, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const paint = {
  dim: (s: string) => wrap("2", s),
  bold: (s: string) => wrap("1", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  magenta: (s: string) => wrap("35", s),
  cyan: (s: string) => wrap("36", s),
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  level: LogLevel;
  constructor(level: LogLevel = "info") {
    this.level = level;
  }
  private rank(l: LogLevel) {
    return { debug: 0, info: 1, warn: 2, error: 3 }[l];
  }
  private emit(l: LogLevel, msg: string) {
    if (this.rank(l) < this.rank(this.level)) return;
    const tag =
      l === "debug" ? paint.dim("[dbg]")
      : l === "info" ? paint.cyan("[inf]")
      : l === "warn" ? paint.yellow("[wrn]")
      : paint.red("[err]");
    process.stderr.write(`${tag} ${msg}\n`);
  }
  debug(msg: string) { this.emit("debug", msg); }
  info(msg: string) { this.emit("info", msg); }
  warn(msg: string) { this.emit("warn", msg); }
  error(msg: string) { this.emit("error", msg); }
}
