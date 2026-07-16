import { _x, _xlog } from "@xpell/core";
import { _xu } from "../XNUtils/XUtils.js";

export type XVMProjectMemoryAchievementId =
  | "first-project-memory-focus"
  | "first-guide-recommendation"
  | "first-suggested-action-applied";

type XVMProjectMemoryAchievementDefinition = {
  _id: XVMProjectMemoryAchievementId;
  _title: string;
};

export type XVMProjectMemoryAchievement = {
  _id: XVMProjectMemoryAchievementId;
  _title: string;
  _type: "onboarding";
  _completed_at: string;
};

export type XVMProjectMemoryAchievementAppendResult = {
  _recorded: boolean;
  _reason?: "duplicate" | "invalid_achievement";
  _memory: Record<string, any>;
  _achievement?: XVMProjectMemoryAchievement;
};

const PROJECT_MEMORY_ACHIEVEMENTS: Record<
  XVMProjectMemoryAchievementId,
  XVMProjectMemoryAchievementDefinition
> = {
  "first-project-memory-focus": {
    _id: "first-project-memory-focus",
    _title: "First project focus set",
  },
  "first-guide-recommendation": {
    _id: "first-guide-recommendation",
    _title: "First guide recommendation received",
  },
  "first-suggested-action-applied": {
    _id: "first-suggested-action-applied",
    _title: "First suggested action applied",
  },
};

function extract_project_memory(value: unknown): Record<string, any> | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (_xu.is_plain_object(value._memory)) {
    return value._memory;
  }

  if (_xu.is_plain_object(value._result)) {
    return extract_project_memory(value._result);
  }

  return undefined;
}

export function append_project_memory_achievement(input: {
  _memory: Record<string, any>;
  _achievement_id: XVMProjectMemoryAchievementId;
  _completed_at?: string;
}): XVMProjectMemoryAchievementAppendResult {
  const memory = _xu.is_plain_object(input._memory) ? input._memory : {};
  const definition = PROJECT_MEMORY_ACHIEVEMENTS[input._achievement_id];
  if (!definition) {
    return {
      _recorded: false,
      _reason: "invalid_achievement",
      _memory: memory,
    };
  }

  const achievements =
    Array.isArray(memory._achievements) ? memory._achievements : [];
  const exists =
    achievements.some((achievement) =>
      _xu.is_plain_object(achievement) &&
      achievement._id === definition._id
    );

  if (exists) {
    return {
      _recorded: false,
      _reason: "duplicate",
      _memory: {
        ...memory,
        _achievements: achievements,
      },
    };
  }

  const achievement: XVMProjectMemoryAchievement = {
    _id: definition._id,
    _title: definition._title,
    _type: "onboarding",
    _completed_at:
      typeof input._completed_at === "string" && input._completed_at.trim().length > 0
        ? input._completed_at
        : _xu.to_iso_now(),
  };

  return {
    _recorded: true,
    _memory: {
      ...memory,
      _achievements: [
        ...achievements,
        achievement,
      ],
    },
    _achievement: achievement,
  };
}

export function log_project_memory_achievement_result(input: {
  _app_id: string;
  _env: string;
  _achievement_id: XVMProjectMemoryAchievementId;
  _result: XVMProjectMemoryAchievementAppendResult;
}) {
  if (input._result._recorded) {
    _xlog.log("[xvibe] project memory achievement recorded", {
      _app_id: input._app_id,
      _env: input._env,
      _achievement_id: input._achievement_id,
    });
    return;
  }

  if (input._result._reason === "duplicate") {
    return;
  }

  _xlog.log("[xvibe] project memory achievement skipped", {
    _app_id: input._app_id,
    _env: input._env,
    _achievement_id: input._achievement_id,
    _reason: input._result._reason ?? "not_recorded",
  });
}

export async function record_project_memory_achievement(input: {
  _app_id: string;
  _env: string;
  _achievement_id: XVMProjectMemoryAchievementId;
}): Promise<XVMProjectMemoryAchievementAppendResult | undefined> {
  try {
    const memory_response = await _x.execute({
      _module: "server-xvm",
      _op: "get-project-memory",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
      },
    } as any);

    if (_xu.is_plain_object(memory_response) && memory_response._ok === false) {
      const skipped: XVMProjectMemoryAchievementAppendResult = {
        _recorded: false,
        _reason: "invalid_achievement",
        _memory: {},
      };
      log_project_memory_achievement_result({
        ...input,
        _result: skipped,
      });
      return skipped;
    }

    const memory = extract_project_memory(memory_response);
    if (!memory) {
      const skipped: XVMProjectMemoryAchievementAppendResult = {
        _recorded: false,
        _reason: "invalid_achievement",
        _memory: {},
      };
      log_project_memory_achievement_result({
        ...input,
        _result: skipped,
      });
      return skipped;
    }

    const append_result = append_project_memory_achievement({
      _memory: memory,
      _achievement_id: input._achievement_id,
    });

    if (!append_result._recorded) {
      log_project_memory_achievement_result({
        ...input,
        _result: append_result,
      });
      return append_result;
    }

    const patch_response = await _x.execute({
      _module: "server-xvm",
      _op: "patch-project-memory",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _patch: {
          _achievements: append_result._memory._achievements,
        },
      },
    } as any);

    if (_xu.is_plain_object(patch_response) && patch_response._ok === false) {
      const skipped: XVMProjectMemoryAchievementAppendResult = {
        _recorded: false,
        _reason: "invalid_achievement",
        _memory: memory,
      };
      log_project_memory_achievement_result({
        ...input,
        _result: skipped,
      });
      return skipped;
    }

    const patched_memory = extract_project_memory(patch_response);
    const recorded_result = patched_memory
      ? {
          ...append_result,
          _memory: patched_memory,
        }
      : append_result;

    log_project_memory_achievement_result({
      ...input,
      _result: recorded_result,
    });
    return recorded_result;
  } catch {
    const skipped: XVMProjectMemoryAchievementAppendResult = {
      _recorded: false,
      _reason: "invalid_achievement",
      _memory: {},
    };
    log_project_memory_achievement_result({
      ...input,
      _result: skipped,
    });
    return skipped;
  }
}
