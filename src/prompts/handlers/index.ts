/**
 * @module prompts/handlers/index
 *
 * Re-exports all prompt handler functions for use in `prompts/index.ts`.
 *
 * Each handler lives in its own file with focused documentation. This barrel
 * re-export keeps the import statement in `prompts/index.ts` concise while
 * preserving the modular file structure.
 *
 * Handler → Prompt mapping:
 *
 *   handleMemoryContext         → "memory_context"
 *   handleStoreConversationTurn → "store_conversation_turn"
 *   handleAgentMemoryProtocol   → "agent_memory_protocol"
 */

export { handleMemoryContext } from "./memory-context.js";
export { handleStoreConversationTurn } from "./store-turn.js";
export { handleAgentMemoryProtocol } from "./protocol.js";
