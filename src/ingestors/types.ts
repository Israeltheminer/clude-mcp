export interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface IngestState {
  /**
   * Session-level ingest tracking, keyed by stable sourceId.
   *
   * - key:   session.sourceId (e.g. "claude-code:/.../file.jsonl")
   * - value: metadata about the last ingest for that logical session
   */
  ingested: Record<
    string,
    {
      /** Last fully processed window index for this session. */
      lastWindow: number;
      /** Last physical path used for this session (for debugging/inspection). */
      lastPath: string;
      /** ISO timestamp of the last successful ingest for this session. */
      updatedAt: string;
    }
  >;
}

export interface IngestOptions {
  window: number;
  threshold: number;
  limit: number;
  project?: string;
  dryRun: boolean;
  chainDream: boolean;
  sourcePath?: string;
  platform: "claude-code" | "claude-web" | "chatgpt" | "cursor" | "auto";
  /**
   * Whether to store episodic memories for each qualifying window.
   * Defaults to true.
   */
  episodic?: boolean;
  /**
   * Whether to store semantic memories (LLM scoring/summarisation).
   * Defaults to false — enable explicitly when you want to rebuild semantic layer.
   */
  semantic?: boolean;
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
  platform: "claude-code" | "claude-web" | "chatgpt" | "cursor" | "generic";
  turns: Turn[];
  /**
   * Optional project identifier for sessions that are naturally scoped
   * to a codebase (e.g. Claude Code projects under ~/.claude/projects/<folder>).
   * For Claude Code, this is the project folder name.
   */
  projectFolder?: string;
  /**
   * Stable identifier for this logical conversation/session.
   * Used to relate memories back to their source and avoid duplicates.
   * Examples:
   * - claude-code:/Users/.../.claude/projects/clude-mcp/123.jsonl
   * - claude-web:<conversation-uuid>
   * - chatgpt:<file>#<title>
   */
  sourceId: string;
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
  episodic: true,
  semantic: true,
};
