import { _xlog } from "@xpell/core";
import { ArtifactResolver } from "../Artifact/ArtifactResolver.js";
import type { ExecutionGraphNode } from "./ExecutionGraphPlanner.js";

export type ExecutionGraphArtifactType =
  | "entity"
  | "flow"
  | "form"
  | "table"
  | "view";

export type ExecutionCapabilityExecutor = "ArtifactExecutor" | null;

export type ExecutionCapabilityDefinition = {
  _id: string;
  _artifact_type: ExecutionGraphArtifactType;
  _supported: boolean;
  _executor: ExecutionCapabilityExecutor;
  _dependencies: string[];
};

type CapabilityArtifactRequestBuilder = (input: {
  _node: ExecutionGraphNode;
  _entity_name: string;
}) => Record<string, any>;

type CapabilityExistenceChecker = (input: {
  _artifact_resolver: ArtifactResolver;
  _app_id: string;
  _env: string;
  _artifact_id: string;
}) => Promise<boolean>;

type RuntimeExecutionCapabilityDefinition = ExecutionCapabilityDefinition & {
  _artifact_request?: CapabilityArtifactRequestBuilder;
  _exists?: CapabilityExistenceChecker;
};

const BUILTIN_CAPABILITIES: Record<string, RuntimeExecutionCapabilityDefinition> = {
  entity: {
    _id: "entity",
    _artifact_type: "entity",
    _supported: true,
    _executor: "ArtifactExecutor",
    _dependencies: [],
    _artifact_request: (input) => ({
      _artifact_type: "entity",
      _artifact_request: {
        _operation: "create",
        _entity_name: input._entity_name,
        ...(input._node._fields?.length
          ? { _fields: input._node._fields }
          : {}),
      },
    }),
    _exists: (input) =>
      input._artifact_resolver.entityExists(
        input._app_id,
        input._env,
        input._artifact_id,
      ),
  },
  flow: {
    _id: "flow",
    _artifact_type: "flow",
    _supported: true,
    _executor: "ArtifactExecutor",
    _dependencies: [],
    _artifact_request: (input) => ({
      _artifact_type: "flow",
      _artifact_request: {
        _operation: "create",
        _flow_id: input._node._artifact_id,
        _entity_name: input._entity_name,
        _action: "entity-add",
      },
    }),
    _exists: (input) =>
      input._artifact_resolver.flowExists(
        input._app_id,
        input._env,
        input._artifact_id,
      ),
  },
  form: {
    _id: "form",
    _artifact_type: "form",
    _supported: true,
    _executor: "ArtifactExecutor",
    _dependencies: [],
    _artifact_request: (input) => ({
      _artifact_type: "form",
      _artifact_request: {
        _operation: "create",
        _entity_name: input._entity_name,
        _view_id: input._node._artifact_id,
      },
    }),
    _exists: (input) =>
      input._artifact_resolver.viewExists(
        input._app_id,
        input._env,
        input._artifact_id,
      ),
  },
  table: {
    _id: "table",
    _artifact_type: "table",
    _supported: true,
    _executor: "ArtifactExecutor",
    _dependencies: [],
    _artifact_request: (input) => ({
      _artifact_type: "table",
      _artifact_request: {
        _operation: "create",
        _entity_name: input._entity_name,
        _view_id: input._node._artifact_id,
      },
    }),
    _exists: (input) =>
      input._artifact_resolver.viewExists(
        input._app_id,
        input._env,
        input._artifact_id,
      ),
  },
  view: {
    _id: "view",
    _artifact_type: "view",
    _supported: false,
    _executor: null,
    _dependencies: [],
    _exists: (input) =>
      input._artifact_resolver.viewExists(
        input._app_id,
        input._env,
        input._artifact_id,
      ),
  },
};

function public_capability(
  capability: RuntimeExecutionCapabilityDefinition,
): ExecutionCapabilityDefinition {
  return {
    _id: capability._id,
    _artifact_type: capability._artifact_type,
    _supported: capability._supported,
    _executor: capability._executor,
    _dependencies: [...capability._dependencies],
  };
}

async function exists_or_false(
  check: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export class CapabilityRegistry {
  lookupCapability(capability_id: string): ExecutionCapabilityDefinition | null {
    const capability = BUILTIN_CAPABILITIES[capability_id];
    if (!capability) {
      return null;
    }

    _xlog.log("[xvibe] capability resolved", {
      _capability: capability._id,
      _artifact_type: capability._artifact_type,
      _executor: capability._executor,
    });

    return public_capability(capability);
  }

  requireCapability(capability_id: string): ExecutionCapabilityDefinition {
    const capability = this.lookupCapability(capability_id);
    if (!capability) {
      throw new Error(`Execution capability not found: ${capability_id}`);
    }

    return capability;
  }

  async artifactExists(input: {
    _capability: string;
    _artifact_resolver: ArtifactResolver;
    _app_id: string;
    _env: string;
    _artifact_id: string;
  }): Promise<boolean> {
    const capability = BUILTIN_CAPABILITIES[input._capability];
    if (!capability) {
      throw new Error(`Execution capability not found: ${input._capability}`);
    }

    this.lookupCapability(input._capability);

    if (!capability._exists) {
      return false;
    }

    return exists_or_false(() =>
      capability._exists!({
        _artifact_resolver: input._artifact_resolver,
        _app_id: input._app_id,
        _env: input._env,
        _artifact_id: input._artifact_id,
      }),
    );
  }

  buildArtifactRequest(input: {
    _capability: string;
    _node: ExecutionGraphNode;
    _entity_name: string;
  }): Record<string, any> | null {
    const capability = BUILTIN_CAPABILITIES[input._capability];
    if (!capability) {
      return null;
    }

    this.lookupCapability(input._capability);

    if (
      !capability._supported ||
      capability._executor !== "ArtifactExecutor" ||
      !capability._artifact_request
    ) {
      return null;
    }

    return capability._artifact_request({
      _node: input._node,
      _entity_name: input._entity_name,
    });
  }
}
