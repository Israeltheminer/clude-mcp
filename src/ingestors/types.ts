export interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface IngestState {
  ingested: Record<string, string>; // filePath → ISO timestamp of ingest
}

export interface IngestOptions {
  window: number;
  threshold: number;
  limit: number;
  project?: string;
  dryRun: boolean;
  chainDream: boolean;
  sourcePath?: string;
  platform: "claude-code" | "chatgpt" | "auto";
}

export interface IngestResult {
  sessionsProcessed: number;
  memoriesStored: number;
  sessionsPending: number;
  sessionsSkipped: number;
  dreamChained: boolean;
}

export interface SessionFile {
  path: string;
  platform: "claude-code" | "chatgpt" | "generic";
  turns: Turn[];
}

export type ProgressEvent =
  | { kind: "session-start"; index: number; total: number; label: string }
  | { kind: "window"; index: number; total: number; windowNum: number; windowTotal: number; status: string }
  | { kind: "rate-limit"; waitSec: number }
  | { kind: "session-done"; index: number; total: number; label: string; memories: number }
  | { kind: "skip"; index: number; total: number; reason: string };

export const DEFAULT_OPTIONS: Omit<IngestOptions, "dryRun" | "chainDream"> = {
  window: 10,
  threshold: 0.4,
  limit: 0,
  platform: "auto",
};
