import fs from "fs-extra";
import path from "node:path";

type LogLevel = "info" | "warn" | "error" | "phase" | "debug";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  data?: unknown;
}

export class Logger {
  private logFilePath?: string;

  public constructor(private readonly verbose: boolean) {}

  public attachLogFile(logsDir: string, runId: string): void {
    fs.ensureDirSync(logsDir);
    this.logFilePath = path.join(logsDir, `${runId}.jsonl`);
  }

  public info(message: string, data?: unknown, event = "info"): void {
    console.log(message);
    this.writeEntry("info", event, message, data);
  }

  public warn(message: string, data?: unknown, event = "warn"): void {
    console.warn(message);
    this.writeEntry("warn", event, message, data);
  }

  public error(message: string, data?: unknown, event = "error"): void {
    console.error(message);
    this.writeEntry("error", event, message, data);
  }

  public phase(message: string, data?: unknown): void {
    const formatted = `[phase] ${message}`;
    console.log(formatted);
    this.writeEntry("phase", "phase", formatted, data);
  }

  public debug(message: string, data?: unknown): void {
    if (this.verbose) {
      console.log(`[debug] ${message}`);
    }
    this.writeEntry("debug", "debug", message, data);
  }

  private writeEntry(
    level: LogLevel,
    event: string,
    message: string,
    data?: unknown
  ): void {
    if (!this.logFilePath) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      data
    };

    fs.appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`);
  }
}
