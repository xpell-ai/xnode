import { _xlog, _xu } from "@xpell/core";
import { ArtifactResolver } from "../Artifact/ArtifactResolver.js";
import {
  CapabilityRegistry,
  type ExecutionCapabilityDefinition,
  type ExecutionGraphArtifactType,
} from "./CapabilityRegistry.js";
import {
  ExecutionRecipeLoader,
  substituteExecutionRecipeTemplate,
  type ExecutionRecipeArtifact,
} from "./ExecutionRecipes.js";
export type { ExecutionGraphArtifactType } from "./CapabilityRegistry.js";

export type ExecutionGraphNode = {
  _id: string;
  _artifact_type: ExecutionGraphArtifactType;
  _artifact_id: string;
  _exists: boolean;
  _required: boolean;
  _depends_on: string[];
  _fields?: ExecutionGraphFieldDescriptor[];
  _children?: ExecutionGraphNode[];
};

export type ExecutionGraphFieldDescriptor = {
  _name: string;
};

export type ExecutionGraphPlan = {
  _nodes: ExecutionGraphNode[];
  _summary: {
    _total: number;
    _existing: number;
    _missing: number;
  };
};

type MaterializedExecutionRecipeArtifact = {
  _recipe_artifact: ExecutionRecipeArtifact;
  _capability: ExecutionCapabilityDefinition;
  _artifact_id: string;
  _node_id: string;
  _children: MaterializedExecutionRecipeArtifact[];
};

const RESERVED_ENTITY_FIELDS = new Set([
  "_id",
  "_created_at",
  "_updated_at",
]);

function normalize_field_name(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .trim()
    .replace(/^[-*]\s*/u, "")
    .replace(/^\d+[.)]\s*/u, "")
    .trim();
  if (!cleaned || RESERVED_ENTITY_FIELDS.has(cleaned.toLowerCase())) {
    return null;
  }

  const normalized = _xu.normalize_id(cleaned);
  if (!normalized || RESERVED_ENTITY_FIELDS.has(normalized)) {
    return null;
  }

  return normalized;
}

export function normalizeExecutionGraphFields(
  value: unknown,
): ExecutionGraphFieldDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen_fields = new Set<string>();
  const fields: ExecutionGraphFieldDescriptor[] = [];
  for (const item of value) {
    const raw_name =
      typeof item === "string"
        ? item
        : _xu.is_plain_object(item)
          ? item._name
          : undefined;
    const field_name = normalize_field_name(raw_name);
    if (!field_name || seen_fields.has(field_name)) {
      continue;
    }

    seen_fields.add(field_name);
    fields.push({ _name: field_name });
  }

  return fields;
}

function materialize_recipe_artifact(
  artifact: ExecutionRecipeArtifact,
  entity_name: string,
  capability_registry: CapabilityRegistry,
): MaterializedExecutionRecipeArtifact {
  const capability = capability_registry.requireCapability(
    artifact._capability,
  );
  const artifact_id = substituteExecutionRecipeTemplate(
    artifact._artifact_id_template,
    { _entity_name: entity_name },
  );

  return {
    _recipe_artifact: artifact,
    _capability: capability,
    _artifact_id: artifact_id,
    _node_id: `${capability._artifact_type}:${artifact_id}`,
    _children: (artifact._children ?? []).map((child) =>
      materialize_recipe_artifact(child, entity_name, capability_registry),
    ),
  };
}

function collect_materialized_artifacts(
  artifacts: MaterializedExecutionRecipeArtifact[],
  collected: MaterializedExecutionRecipeArtifact[] = [],
): MaterializedExecutionRecipeArtifact[] {
  for (const artifact of artifacts) {
    collected.push(artifact);
    collect_materialized_artifacts(artifact._children, collected);
  }

  return collected;
}

function collect_graph_nodes(
  nodes: ExecutionGraphNode[],
  collected: ExecutionGraphNode[] = [],
): ExecutionGraphNode[] {
  for (const node of nodes) {
    collected.push(node);
    collect_graph_nodes(node._children ?? [], collected);
  }

  return collected;
}

export class ExecutionGraphPlanner {
  private readonly artifact_resolver: ArtifactResolver;
  private readonly recipe_loader: ExecutionRecipeLoader;
  private readonly capability_registry: CapabilityRegistry;

  constructor(
    artifact_resolver = new ArtifactResolver(),
    recipe_loader = new ExecutionRecipeLoader(),
    capability_registry = new CapabilityRegistry(),
  ) {
    this.artifact_resolver = artifact_resolver;
    this.recipe_loader = recipe_loader;
    this.capability_registry = capability_registry;
  }

  async planCrud(input: {
    _app_id: string;
    _env: string;
    _entity_name: string;
    _fields?: unknown;
  }): Promise<ExecutionGraphPlan> {
    const entity_name = _xu.normalize_id(input._entity_name);
    if (!entity_name) {
      throw new Error("ExecutionGraphPlanner requires a valid entity name");
    }
    const fields = normalizeExecutionGraphFields(input._fields);

    const recipe = this.recipe_loader.loadRecipe("crud");
    const materialized_artifacts = recipe._artifacts.map((artifact) =>
      materialize_recipe_artifact(
        artifact,
        entity_name,
        this.capability_registry,
      ),
    );
    const all_materialized_artifacts =
      collect_materialized_artifacts(materialized_artifacts);
    const node_id_by_capability = new Map(
      all_materialized_artifacts.map((artifact) => [
        artifact._recipe_artifact._capability,
        artifact._node_id,
      ]),
    );

    const build_node = async (
      artifact: MaterializedExecutionRecipeArtifact,
    ): Promise<ExecutionGraphNode> => {
      const children: ExecutionGraphNode[] = [];
      for (const child of artifact._children) {
        children.push(await build_node(child));
      }
      const node_fields =
        artifact._recipe_artifact._capability === "entity" && fields.length > 0
          ? fields
          : undefined;
      if (artifact._recipe_artifact._capability === "entity") {
        _xlog.log("[xvibe] graph node fields", {
          _node_id: artifact._node_id,
          _artifact_type: artifact._capability._artifact_type,
          _artifact_id: artifact._artifact_id,
          _fields: node_fields ?? [],
        });
      }

      return {
        _id: artifact._node_id,
        _artifact_type: artifact._capability._artifact_type,
        _artifact_id: artifact._artifact_id,
        _exists: await this.capability_registry.artifactExists({
          _app_id: input._app_id,
          _env: input._env,
          _capability: artifact._recipe_artifact._capability,
          _artifact_resolver: this.artifact_resolver,
          _artifact_id: artifact._artifact_id,
        }),
        _required: artifact._recipe_artifact._required,
        _depends_on: artifact._recipe_artifact._depends_on.map(
          (capability) => {
            const dependency_node_id = node_id_by_capability.get(capability);
            if (!dependency_node_id) {
              throw new Error(
                `Execution recipe dependency not found: ${capability}`,
              );
            }

            return dependency_node_id;
          },
        ),
        ...(node_fields ? { _fields: node_fields } : {}),
        ...(children.length > 0 ? { _children: children } : {}),
      };
    };

    const nodes: ExecutionGraphNode[] = [];
    for (const artifact of materialized_artifacts) {
      nodes.push(await build_node(artifact));
    }

    const all_nodes = collect_graph_nodes(nodes);
    const existing = all_nodes.filter((node) => node._exists).length;
    const graph = {
      _nodes: nodes,
      _summary: {
        _total: all_nodes.length,
        _existing: existing,
        _missing: all_nodes.length - existing,
      },
    };

    _xlog.log("[xvibe] execution graph planned", {
      _graph_type: "crud",
      _entity_name: entity_name,
      _total: graph._summary._total,
      _existing: graph._summary._existing,
      _missing: graph._summary._missing,
    });

    return graph;
  }
}
