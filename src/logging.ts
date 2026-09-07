export type LogFormat = "text" | "json";

export class Logger {
  constructor(private verboseEnabled = false, private format: LogFormat = "text") {}

  info(event: string, message: string, details: Record<string, unknown> = {}): void {
    this.write("info", event, message, details);
  }

  verbose(event: string, message: string, details: Record<string, unknown> = {}): void {
    if (this.verboseEnabled) this.write("debug", event, message, details);
  }

  error(event: string, message: string, details: Record<string, unknown> = {}): void {
    this.write("error", event, message, details);
  }

  private write(level: string, event: string, message: string, details: Record<string, unknown>): void {
    if (this.format === "json") {
      process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, message, ...details })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
  }
}
