import { _xu } from "@xpell/node-core";

export type XVMProjectMemoryStage =
  | "planning"
  | "building"
  | "review"
  | "completed";

const PROJECT_MEMORY_STAGES = new Set<XVMProjectMemoryStage>([
  "planning",
  "building",
  "review",
  "completed",
]);

function read_stage(value: unknown): XVMProjectMemoryStage | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  return PROJECT_MEMORY_STAGES.has(normalized as XVMProjectMemoryStage)
    ? normalized as XVMProjectMemoryStage
    : undefined;
}

function has_items(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (_xu.is_plain_object(value)) return Object.keys(value).length > 0;

  return false;
}

export function resolveProjectStage(
  projectMemory: unknown,
): XVMProjectMemoryStage {
  const memory = _xu.is_plain_object(projectMemory) ? projectMemory : {};
  const explicit_stage = read_stage(memory._stage);
  if (explicit_stage) return explicit_stage;

  if (
    has_items(memory._completed) ||
    has_items(memory._entities) ||
    has_items(memory._milestones)
  ) {
    return "building";
  }

  return "planning";
}
