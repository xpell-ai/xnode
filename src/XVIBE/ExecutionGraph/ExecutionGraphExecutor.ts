import { _xlog, _xu, type XCommand } from "@xpell/core";
import { ArtifactExecutor } from "../Artifact/ArtifactExecutor.js";
import { CapabilityRegistry } from "./CapabilityRegistry.js";
import {
  ExecutionGraphPlanner,
  normalizeExecutionGraphFields,
  type ExecutionGraphArtifactType,
  type ExecutionGraphNode,
} from "./ExecutionGraphPlanner.js";

export type ExecutionGraphNodeExecutionStatus =
  | "existing"
  | "created"
  | "skipped"
  | "failed";

export type ExecutionGraphExecutionNodeResult = {
  _id: string;
  _artifact_type: ExecutionGraphArtifactType;
  _artifact_id: string;
  _status: ExecutionGraphNodeExecutionStatus;
  _reason?: string;
  _result?: Record<string, any>;
  _error?: Record<string, any>;
  _children?: ExecutionGraphExecutionNodeResult[];
};

export type ExecutionGraphExecutionResult = {
  _ok: true;
  _graph_type: "crud";
  _entity_name: string;
  _nodes: ExecutionGraphExecutionNodeResult[];
  _summary: {
    _existing: number;
    _created: number;
    _skipped: number;
    _failed: number;
  };
};

type ExecutionGraphExecutorError = {
  _ok: false;
  _error: {
    _code: "E_XVIBE_EXECUTION_GRAPH_REQUEST_INVALID";
    _message: string;
    _details?: Record<string, any>;
  };
};

type ExecutionGraphExecutorApplyResult =
  | ExecutionGraphExecutionResult
  | ExecutionGraphExecutorError;

type ExecutionGraphNodeExecutionOutcome = {
  _result: ExecutionGraphExecutionNodeResult;
  _stop_required: boolean;
};

function error_result(
  message: string,
  details?: Record<string, any>,
): ExecutionGraphExecutorError {
  return {
    _ok: false,
    _error: {
      _code: "E_XVIBE_EXECUTION_GRAPH_REQUEST_INVALID",
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function nodes_in_dependency_order(nodes: ExecutionGraphNode[]): ExecutionGraphNode[] {
  const pending = new Map(nodes.map((node) => [node._id, node]));
  const ordered: ExecutionGraphNode[] = [];
  const completed = new Set<string>();

  while (pending.size > 0) {
    let progressed = false;

    for (const node of nodes) {
      if (!pending.has(node._id)) {
        continue;
      }

      const dependencies_met = node._depends_on.every(
        (dependency_id) =>
          completed.has(dependency_id) || !pending.has(dependency_id),
      );
      if (!dependencies_met) {
        continue;
      }

      ordered.push(node);
      pending.delete(node._id);
      completed.add(node._id);
      progressed = true;
    }

    if (!progressed) {
      throw new Error("Execution graph contains an unresolved dependency cycle");
    }
  }

  return ordered;
}

function collect_result_nodes(
  nodes: ExecutionGraphExecutionNodeResult[],
  collected: ExecutionGraphExecutionNodeResult[] = [],
): ExecutionGraphExecutionNodeResult[] {
  for (const node of nodes) {
    collected.push(node);
    collect_result_nodes(node._children ?? [], collected);
  }

  return collected;
}

function summarize_nodes(nodes: ExecutionGraphExecutionNodeResult[]) {
  const all_nodes = collect_result_nodes(nodes);

  return {
    _existing: all_nodes.filter((node) => node._status === "existing").length,
    _created: all_nodes.filter((node) => node._status === "created").length,
    _skipped: all_nodes.filter((node) => node._status === "skipped").length,
    _failed: all_nodes.filter((node) => node._status === "failed").length,
  };
}

function error_payload(error: unknown): Record<string, any> {
  if (_xu.is_plain_object(error)) {
    return error as Record<string, any>;
  }

  if (error instanceof Error) {
    return {
      _message: error.message,
    };
  }

  return {
    _message: String(error),
  };
}

function collect_client_graph_nodes(
  value: unknown,
  collected: Record<string, any>[] = [],
): Record<string, any>[] {
  if (!_xu.is_plain_object(value)) {
    return collected;
  }

  if (Array.isArray(value._nodes)) {
    for (const node of value._nodes) {
      collect_client_graph_nodes(node, collected);
    }
  } else {
    collected.push(value);
  }

  if (Array.isArray(value._children)) {
    for (const child of value._children) {
      collect_client_graph_nodes(child, collected);
    }
  }

  return collected;
}

function execution_request_fields(input: {
  _params: Record<string, any>;
  _entity_name: string;
}) {
  const request_fields = normalizeExecutionGraphFields(input._params._fields);
  if (request_fields.length > 0) {
    return request_fields;
  }

  const client_graph = input._params._execution_graph;
  if (!_xu.is_plain_object(client_graph)) {
    return [];
  }

  for (const node of collect_client_graph_nodes(client_graph)) {
    if (
      node._artifact_type !== "entity" ||
      node._artifact_id !== input._entity_name
    ) {
      continue;
    }

    const graph_fields = normalizeExecutionGraphFields(node._fields);
    if (graph_fields.length > 0) {
      return graph_fields;
    }
  }

  return [];
}

export class ExecutionGraphExecutor {
  private readonly planner: ExecutionGraphPlanner;
  private readonly artifact_executor: ArtifactExecutor;
  private readonly capability_registry: CapabilityRegistry;

  constructor(
    planner = new ExecutionGraphPlanner(),
    artifact_executor = new ArtifactExecutor(),
    capability_registry = new CapabilityRegistry(),
  ) {
    this.planner = planner;
    this.artifact_executor = artifact_executor;
    this.capability_registry = capability_registry;
  }

  private skipNodeWithChildren(
    node: ExecutionGraphNode,
    reason: string,
  ): ExecutionGraphExecutionNodeResult {
    const result: ExecutionGraphExecutionNodeResult = {
      _id: node._id,
      _artifact_type: node._artifact_type,
      _artifact_id: node._artifact_id,
      _status: "skipped",
      _reason: reason,
      ...(node._children?.length
        ? {
            _children: node._children.map((child) =>
              this.skipNodeWithChildren(child, reason),
            ),
          }
        : {}),
    };
    _xlog.log("[xvibe] execution graph node skipped", result);
    return result;
  }

  private async executeChildren(input: {
    _nodes: ExecutionGraphNode[];
    _entity_name: string;
    _app_id: string;
    _env: string;
  }): Promise<{
    _results: ExecutionGraphExecutionNodeResult[];
    _stop_required: boolean;
  }> {
    const results: ExecutionGraphExecutionNodeResult[] = [];
    const ordered_nodes = nodes_in_dependency_order(input._nodes);

    for (const node of ordered_nodes) {
      const outcome = await this.executeNode({
        _node: node,
        _entity_name: input._entity_name,
        _app_id: input._app_id,
        _env: input._env,
      });
      results.push(outcome._result);
      if (outcome._stop_required) {
        return {
          _results: results,
          _stop_required: true,
        };
      }
    }

    return {
      _results: results,
      _stop_required: false,
    };
  }

  private async attachChildResults(input: {
    _result: ExecutionGraphExecutionNodeResult;
    _node: ExecutionGraphNode;
    _entity_name: string;
    _app_id: string;
    _env: string;
  }): Promise<ExecutionGraphNodeExecutionOutcome> {
    if (!input._node._children?.length) {
      return {
        _result: input._result,
        _stop_required: false,
      };
    }

    const children = await this.executeChildren({
      _nodes: input._node._children,
      _entity_name: input._entity_name,
      _app_id: input._app_id,
      _env: input._env,
    });
    input._result._children = children._results;

    return {
      _result: input._result,
      _stop_required: children._stop_required,
    };
  }

  private async executeNode(input: {
    _node: ExecutionGraphNode;
    _entity_name: string;
    _app_id: string;
    _env: string;
  }): Promise<ExecutionGraphNodeExecutionOutcome> {
    const node = input._node;

    if (node._exists) {
      const result: ExecutionGraphExecutionNodeResult = {
        _id: node._id,
        _artifact_type: node._artifact_type,
        _artifact_id: node._artifact_id,
        _status: "existing",
      };
      _xlog.log("[xvibe] execution graph node existing", result);
      return this.attachChildResults({
        _result: result,
        _node: node,
        _entity_name: input._entity_name,
        _app_id: input._app_id,
        _env: input._env,
      });
    }

    const capability = this.capability_registry.lookupCapability(
      node._artifact_type,
    );
    if (!capability?._supported) {
      const result: ExecutionGraphExecutionNodeResult = {
        _id: node._id,
        _artifact_type: node._artifact_type,
        _artifact_id: node._artifact_id,
        _status: "skipped",
        _reason: "unsupported_artifact_type",
      };
      _xlog.log("[xvibe] execution graph node skipped", result);
      return this.attachChildResults({
        _result: result,
        _node: node,
        _entity_name: input._entity_name,
        _app_id: input._app_id,
        _env: input._env,
      });
    }

    const artifact_request = this.capability_registry.buildArtifactRequest({
      _capability: capability._id,
      _node: node,
      _entity_name: input._entity_name,
    });
    if (node._artifact_type === "entity") {
      _xlog.log("[xvibe] executor forwarding fields", {
        _node_id: node._id,
        _entity_name: input._entity_name,
        _fields: artifact_request?._artifact_request?._fields ?? [],
      });
    }
    if (!artifact_request) {
      const result: ExecutionGraphExecutionNodeResult = {
        _id: node._id,
        _artifact_type: node._artifact_type,
        _artifact_id: node._artifact_id,
        _status: "skipped",
        _reason: "unsupported_artifact_type",
      };
      _xlog.log("[xvibe] execution graph node skipped", result);
      return this.attachChildResults({
        _result: result,
        _node: node,
        _entity_name: input._entity_name,
        _app_id: input._app_id,
        _env: input._env,
      });
    }

    const artifact_result = await this.artifact_executor.apply({
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        ...artifact_request,
      },
    } as any);

    if (artifact_result?._ok === true) {
      const result: ExecutionGraphExecutionNodeResult = {
        _id: node._id,
        _artifact_type: node._artifact_type,
        _artifact_id: node._artifact_id,
        _status: "created",
        _result: artifact_result as Record<string, any>,
      };
      _xlog.log("[xvibe] execution graph node created", {
        _id: result._id,
        _artifact_type: result._artifact_type,
        _artifact_id: result._artifact_id,
      });
      return this.attachChildResults({
        _result: result,
        _node: node,
        _entity_name: input._entity_name,
        _app_id: input._app_id,
        _env: input._env,
      });
    }

    const result: ExecutionGraphExecutionNodeResult = {
      _id: node._id,
      _artifact_type: node._artifact_type,
      _artifact_id: node._artifact_id,
      _status: "failed",
      _error: error_payload(
        _xu.is_plain_object(artifact_result)
          ? artifact_result._error ?? artifact_result
          : artifact_result,
      ),
    };
    if (node._children?.length) {
      result._children = node._children.map((child) =>
        this.skipNodeWithChildren(child, "parent_failed"),
      );
    }
    _xlog.log("[xvibe] execution graph node failed", result);

    return {
      _result: result,
      _stop_required: node._required,
    };
  }

  async apply(xcmd: XCommand): Promise<ExecutionGraphExecutorApplyResult> {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    _xlog.log("[xvibe] execution graph execute received", {
      _graph_type: params._graph_type,
      _entity_name: params._entity_name,
      _client_graph_provided: _xu.is_plain_object(params._execution_graph),
    });

    if (params._graph_type !== "crud") {
      return error_result("_graph_type must be crud", {
        _graph_type: params._graph_type,
      });
    }

    if (typeof params._app_id !== "string" || params._app_id.trim().length === 0) {
      return error_result("_app_id must be a non-empty string");
    }

    if (typeof params._env !== "string" || params._env.trim().length === 0) {
      return error_result("_env must be a non-empty string");
    }

    if (
      typeof params._entity_name !== "string" ||
      params._entity_name.trim().length === 0
    ) {
      return error_result("_entity_name must be a non-empty string");
    }

    const entity_name = _xu.normalize_id(params._entity_name);
    if (!entity_name) {
      return error_result("_entity_name must normalize to a non-empty id");
    }
    const fields = execution_request_fields({
      _params: params,
      _entity_name: entity_name,
    });

    const graph = await this.planner.planCrud({
      _app_id: params._app_id.trim(),
      _env: params._env.trim(),
      _entity_name: entity_name,
      _fields: fields,
    });

    const results: ExecutionGraphExecutionNodeResult[] = [];
    const ordered_nodes = nodes_in_dependency_order(graph._nodes);

    for (const node of ordered_nodes) {
      const outcome = await this.executeNode({
        _node: node,
        _entity_name: entity_name,
        _app_id: params._app_id.trim(),
        _env: params._env.trim(),
      });
      results.push(outcome._result);
      if (outcome._stop_required) {
        break;
      }
    }

    const response: ExecutionGraphExecutionResult = {
      _ok: true,
      _graph_type: "crud",
      _entity_name: entity_name,
      _nodes: results,
      _summary: summarize_nodes(results),
    };

    _xlog.log("[xvibe] execution graph execution completed", {
      _graph_type: response._graph_type,
      _entity_name: response._entity_name,
      ...response._summary,
    });

    return response;
  }
}
