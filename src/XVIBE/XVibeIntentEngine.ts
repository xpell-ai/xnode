import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentEngineResponse,
  XVibeIntentResult,
} from "./XVibeTypes.js";
import { IntentMemoryStore } from "./IntentMemory/IntentMemoryStore.js";
import { DeterministicIntentProcessor } from "./Processors/DeterministicIntentProcessor.js";
import { CrudProcessor } from "./Processors/CrudProcessor.js";
import { EntityProcessor } from "./Processors/EntityProcessor.js";
import { FlowProcessor } from "./Processors/FlowProcessor.js";
import { FormProcessor } from "./Processors/FormProcessor.js";
import { TableProcessor } from "./Processors/TableProcessor.js";
import { AddFieldProcessor } from "./Processors/AddFieldProcessor.js";
import { RenameFieldProcessor } from "./Processors/RenameFieldProcessor.js";
import { DeprecateFieldProcessor } from "./Processors/DeprecateFieldProcessor.js";
import { DeleteFieldProcessor } from "./Processors/DeleteFieldProcessor.js";
import { RestoreDeprecatedFieldProcessor } from "./Processors/RestoreDeprecatedFieldProcessor.js";
import { LearnedIntentProcessor } from "./Processors/LearnedIntentProcessor.js";
import {
  SemanticIntentProcessor,
  type XVibeSemanticIntentGenerateJson,
} from "./Processors/SemanticIntentProcessor.js";
import type { XVibeIntentProcessor } from "./Processors/XVibeIntentProcessor.js";
import { RuntimeContextManager } from "./Runtime/RuntimeContextManager.js";
import { ProjectMemoryFocusProcessor } from "./Processors/ProjectMemoryFocusProcessor.js";
import { PlanningSessionProcessor } from "./Processors/PlanningSessionProcessor.js";
import { PlanningProcessor } from "./Processors/PlanningProcessor.js";
import { CapabilityGuidanceProcessor } from "./Processors/CapabilityGuidanceProcessor.js";
import { MutationPlanningProcessor } from "./Processors/MutationPlanningProcessor.js";

export type XVibeIntentEngineOptions = {
  _intent_memory_store?: IntentMemoryStore;
  _semantic_generate_json?: XVibeSemanticIntentGenerateJson;
};

export class XVibeIntentEngine {
  private readonly processors: XVibeIntentProcessor[];

  constructor(options: XVibeIntentEngineOptions = {}) {
    this.processors = [
      new CapabilityGuidanceProcessor(),
      new MutationPlanningProcessor(),
      new DeterministicIntentProcessor(),
      new ProjectMemoryFocusProcessor(),
      new PlanningSessionProcessor(),
      new PlanningProcessor(),
      new LearnedIntentProcessor({
        _store: options._intent_memory_store,
      }),
      new EntityProcessor(),
      new FlowProcessor(),
      new FormProcessor(),
      new TableProcessor(),
      new CrudProcessor(),
      new AddFieldProcessor(),
      new RenameFieldProcessor(),
      new DeprecateFieldProcessor(),
      new DeleteFieldProcessor(),
      new RestoreDeprecatedFieldProcessor(),
      new SemanticIntentProcessor({
        _generate_json: options._semantic_generate_json,
      }),
    ];
  }

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentEngineResponse> {
    const started_at = Date.now();
    const processor_chain = this.processor_chain();
    const validation_error = this.validate_request(request);
    if (validation_error) {
      return {
        _ok: false,
        _error: "invalid_intent_request",
        _reason: validation_error,
        _processor_chain: processor_chain,
        _duration_ms: Date.now() - started_at,
      };
    }

    const enriched_request: XVibeIntentEngineRequest = {
      ...request,
      _runtime_context:
        await RuntimeContextManager.attachProjectMemoryToRuntimeContext(
          request._runtime_context,
        ),
    };

    for (const processor of this.processors) {
      const processor_started_at = Date.now();
      const processor_name = this.processor_name(processor);
      const intent = await processor.analyze(enriched_request);
      const processor_duration_ms =
        Date.now() - processor_started_at;
      if (intent) {
        _xlog.log("[xvibe] processor matched", {
          _processor: processor_name,
          _duration_ms: processor_duration_ms,
        });
        return {
          _ok: true,
          _intent: intent,
          _processor: processor_name,
          _processor_chain: processor_chain,
          _duration_ms: Date.now() - started_at,
        };
      }

      _xlog.log("[xvibe] processor returned null", {
        _processor: processor_name,
        _reason: this.processor_diagnostic_reason(processor),
        _duration_ms: processor_duration_ms,
      });
    }

    _xlog.log("[xvibe] processor fallback", {
      _processor_chain: processor_chain,
    });
    return {
      _ok: true,
      _intent: this.stub_conversation_intent(),
      _processor_chain: processor_chain,
      _duration_ms: Date.now() - started_at,
    };
  }

  private processor_chain(): string[] {
    return this.processors.map((processor) =>
      this.processor_name(processor),
    );
  }

  private processor_name(processor: XVibeIntentProcessor): string {
    return processor.constructor?.name || "XVibeIntentProcessor";
  }

  private processor_diagnostic_reason(processor: XVibeIntentProcessor): string {
    return processor._diagnostic_reason?.() ?? "processor_returned_null";
  }

  private stub_conversation_intent(): XVibeIntentResult {
    return {
      _message_type: "conversation",
      _execution_level: "none",
      _should_mutate: false,
      _confidence: 0,
      _reason: "stub_intent_engine",
      _actions: [],
      _warnings: [],
    };
  }

  private validate_request(request: XVibeIntentEngineRequest): string | null {
    if (!_xu.is_plain_object(request)) {
      return "request must be an object";
    }

    if (typeof request._message !== "string") {
      return "_message must be string";
    }

    if (!_xu.is_plain_object(request._runtime_context)) {
      return "_runtime_context required";
    }

    if (!_xu.is_non_empty_string(request._runtime_context._app_id)) {
      return "_runtime_context._app_id required";
    }

    if (!_xu.is_non_empty_string(request._runtime_context._env)) {
      return "_runtime_context._env required";
    }

    return null;
  }
}
