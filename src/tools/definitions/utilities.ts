/**
 * @module tools/definitions/utilities
 *
 * JSON schema definitions for the two local utility tools:
 *
 *   infer_concepts  — Extract structured concept labels from text.
 *   format_context  — Format a memory array into an LLM-ready context block.
 *
 * ## Key Distinction: These Run Locally
 *
 * Unlike the cognition tools (dream, score_importance), these two utilities
 * run entirely on the local machine — no LLM API call, no network request,
 * no Anthropic key required:
 *
 *   infer_concepts  — Pure regex + pattern matching against a 12-category ontology.
 *   format_context  — Pure string formatting of an in-memory array.
 *
 * This makes them free to call in any quantity with zero latency cost.
 *
 * ## infer_concepts
 *
 * The concept ontology recognises 12 concept types:
 *   person, project, token/crypto, location, emotion, tool/technology,
 *   organisation, event, time-reference, goal, problem, decision
 *
 * The function scans the summary text for patterns matching each type and
 * returns an array of concept strings like ["person:Israel", "project:tale",
 * "tool:TypeScript"]. These strings are useful as tags because they carry
 * both the type and the entity name.
 *
 * Always call infer_concepts before store_memory and pass the result as tags
 * if you have not already generated tags manually.
 *
 * ## format_context
 *
 * Takes the raw Memory[] array returned by recall_memories or hydrate_memories
 * and produces a formatted block suitable for injection into a system prompt
 * or user turn. The SDK formats each memory as:
 *
 *   [memory_type] (importance: X.X)
 *   Summary: <summary>
 *   <content>
 *   Tags: tag1, tag2
 *   ---
 *
 * The output is a single string ready to splice into the model's context.
 * This is what the memory_context prompt uses internally.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Schema for the infer_concepts tool. */
export const inferConceptsDef: Tool = {
  name: "infer_concepts",
  description:
    "Extract structured concept labels from text using the built-in ontology " +
    "(twelve concept types: person, project, token, location, emotion, tool, " +
    "organisation, event, time-reference, goal, problem, decision). " +
    "Returns an array of 'type:entity' strings for use as tags. " +
    "Runs locally — no LLM call, no latency. " +
    "Call before store_memory to auto-generate tags.",
  inputSchema: {
    type: "object",
    required: ["summary", "source"],
    properties: {
      summary: {
        type: "string",
        description:
          "Text to analyse for concepts. Typically the memory summary, " +
          "but may also include the first portion of the content for richer results.",
      },
      source: {
        type: "string",
        description:
          "Source context hint. Helps the ontology prioritise which concept types " +
          "to look for. E.g. 'chat' suggests person/emotion/goal; " +
          "'document' suggests organisation/project/tool.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Existing tags to merge with inferred concepts. " +
          "The function deduplicates before returning. Default: [].",
        default: [],
      },
    },
  },
};

/** Schema for the format_context tool. */
export const formatContextDef: Tool = {
  name: "format_context",
  description:
    "Format an array of Memory objects into an LLM-ready context block. " +
    "Returns a single string you can inject directly into a system prompt or " +
    "user turn. Runs locally — no LLM call. " +
    "Accepts the 'memories' array from recall_memories or hydrate_memories output.",
  inputSchema: {
    type: "object",
    required: ["memories"],
    properties: {
      memories: {
        type: "array",
        description:
          "Array of Memory objects as returned by recall_memories or hydrate_memories. " +
          "Pass the full array — the formatter handles ordering and truncation internally.",
        items: { type: "object" },
      },
    },
  },
};
