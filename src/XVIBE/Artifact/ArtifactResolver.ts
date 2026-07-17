import { _x } from "@xpell/core";
import { _xu } from "@xpell/node-core";

export type ArtifactResolverRecord = Record<string, any>;

function read_artifact(value: unknown, key: string): ArtifactResolverRecord | null {
  if (!_xu.is_plain_object(value)) {
    return null;
  }

  const artifact = value[key];
  return _xu.is_plain_object(artifact) ? artifact : null;
}

function read_artifact_ids(
  value: unknown,
  key: string,
): string[] {
  if (!_xu.is_plain_object(value) || !Array.isArray(value[key])) {
    return [];
  }

  return value[key]
    .map((item: unknown) => {
      if (typeof item === "string") return item;
      if (_xu.is_plain_object(item) && typeof item._id === "string") {
        return item._id;
      }
      return undefined;
    })
    .filter((item: unknown): item is string => typeof item === "string");
}

export class ArtifactResolver {
  async getEntity(
    app_id: string,
    env: string,
    entity_name: string,
  ): Promise<ArtifactResolverRecord | null> {
    try {
      const response = await _x.execute({
        _module: "server-xvm",
        _op: "get_entity",
        _params: {
          _app_id: app_id,
          _env: env,
          _entity_id: entity_name,
        },
      } as any);

      return response?._ok
        ? read_artifact(response._result, "_entity")
        : null;
    } catch {
      return null;
    }
  }

  async entityExists(
    app_id: string,
    env: string,
    entity_name: string,
  ): Promise<boolean> {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "list_entities",
      _params: {
        _app_id: app_id,
        _env: env,
      },
    } as any);

    if (!response?._ok) {
      throw new Error("Failed to inspect existing entity artifacts");
    }

    return read_artifact_ids(response._result, "_entities").includes(
      entity_name,
    );
  }

  async getFlow(
    app_id: string,
    env: string,
    flow_id: string,
  ): Promise<ArtifactResolverRecord | null> {
    try {
      const response = await _x.execute({
        _module: "server-xvm",
        _op: "get_flow",
        _params: {
          _app_id: app_id,
          _env: env,
          _flow_id: flow_id,
        },
      } as any);

      return response?._ok
        ? read_artifact(response._result, "_flow")
        : null;
    } catch {
      return null;
    }
  }

  async flowExists(
    app_id: string,
    env: string,
    flow_id: string,
  ): Promise<boolean> {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "list_flows",
      _params: {
        _app_id: app_id,
        _env: env,
      },
    } as any);

    if (!response?._ok) {
      throw new Error("Failed to inspect existing flow artifacts");
    }

    return read_artifact_ids(response._result, "_flows").includes(flow_id);
  }

  async getView(
    app_id: string,
    env: string,
    view_id: string,
  ): Promise<ArtifactResolverRecord | null> {
    try {
      const response = await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
        },
      } as any);

      return response?._ok
        ? read_artifact(response._result, "_view")
        : null;
    } catch {
      return null;
    }
  }

  async viewExists(
    app_id: string,
    env: string,
    view_id: string,
  ): Promise<boolean> {
    return (await this.getView(app_id, env, view_id)) !== null;
  }
}
