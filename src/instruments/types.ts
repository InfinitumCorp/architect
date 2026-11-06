import type { Evidence, EvidenceKind, Permission, Risk } from "../types.js";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
  /** Permission the Score must hold for this tool to run. */
  permission: Permission;
  /** Static risk, or a classifier that inspects the input (and may look at live state). */
  risk: Risk | ((input: Record<string, unknown>) => Risk | Promise<Risk>);
}

export interface ToolContext {
  runId: string;
  stepId: string;
  runDir: string;
  addEvidence(e: { kind: EvidenceKind; label: string; content?: string; path?: string }): Evidence;
}

export interface ToolImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
}

export interface ToolOutput {
  text: string;
  image?: ToolImage;
  /** Set when the tool ran but did not succeed; returned to the model as an error result. */
  isError?: boolean;
}

/** A capability Architech can play. */
export interface Instrument {
  name: string;
  description: string;
  tools: ToolSpec[];
  execute(tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
  /** Called when a run is packaged for a person to take over. */
  handoff?(ctx: ToolContext): Promise<Record<string, string>>;
  dispose?(): Promise<void>;
}

export class ToolInputError extends Error {}

/** Minimal JSON-schema check for model-supplied tool input (required keys + primitive types). */
export function validateInput(schema: JsonSchemaObject, input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("tool input must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) throw new ToolInputError(`missing required field "${key}"`);
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!prop) {
      if (schema.additionalProperties === false) throw new ToolInputError(`unknown field "${key}"`);
      continue;
    }
    if (prop.type && value !== null && value !== undefined) {
      const actual = Array.isArray(value) ? "array" : typeof value;
      const expected = prop.type === "integer" ? "number" : prop.type;
      if (actual !== expected) throw new ToolInputError(`field "${key}" must be ${prop.type}`);
    }
    if (prop.enum && !prop.enum.includes(value)) {
      throw new ToolInputError(`field "${key}" must be one of ${prop.enum.join(", ")}`);
    }
  }
  return obj;
}
