import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { IngestState } from "./types.js";

const STATE_FILE = join(homedir(), ".claude", "clude-ingest-state.json");

export function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  }
  return { ingested: {} };
}

export function saveState(state: IngestState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
