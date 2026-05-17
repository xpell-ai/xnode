import {
  XModule,
  type XCommand,
  _x,
  _xd,
  _xlog,
  XResponseOK,
  XResponseError
} from "@xpell/core";

import { _xem } from "../XEM/XEventManager.js";
import { _xu } from "../XNUtils/XUtils.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type XFlowStep = {
  _id?: string;

  _command: {
    _module: string;
    _op: string;
    _params?: Record<string, any>;
    _object?: string;
  };

  _input?: Record<string, { _from: "xdata"; _key: string }>;

  _output?: {
    _to: { _type: "xdata"; _key: string };
    _value?: any;
  };

  _when?: {
    _type: "xdata" | "event";
    _key: string;
    _equals?: any;
    _not_equals?: any;
  };
};

type XFlow = {
  _id: string;
  _meta?: Record<string, any>;
  _steps: XFlowStep[];
};

/* -------------------------------------------------------------------------- */

export class FlowManagerModule extends XModule {
  static _name = "flow";

  private _opts: any;
  private _default_env: string;
  private _debug: boolean;

  constructor(opts: any = {}) {
    super({ _name: FlowManagerModule._name });

    this._opts = opts;
    this._default_env = opts._default_env ?? "default";
    this._debug = opts._debug === true;
  }

  /* ------------------------------------------------------------------------ */
  /* RUN FLOW                                                                 */
  /* ------------------------------------------------------------------------ */

  async _run(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const flow_id = _xu.ensure_string(params._flow_id, "_flow_id");
    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = params._env ?? this._default_env;

    const event_payload =
      typeof params._event_payload === "object" && params._event_payload !== null
        ? params._event_payload
        : {};

    const ctx = {
      event: event_payload,
      step_results: {} as Record<string, any>
    };

    const outputs: Record<string, any> = {};

    /* ---------------------------------------------------------------------- */
    /* LOAD FLOW                                                              */
    /* ---------------------------------------------------------------------- */

    const res = await _x.execute({
      _module: "server-xvm",
      _op: "get_flow",
      _params: { _app_id: app_id, _flow_id: flow_id, _env: env }
    });

    if (!res?._ok) {
      return new XResponseError({
        _code: "FLOW_LOAD_FAILED",
        _message: `Flow load failed: ${flow_id}`,
        _details: res
      }).toXData();
    }

    const flow: XFlow = res._result._flow;

    if (!Array.isArray(flow._steps)) {
      return new XResponseError({
        _code: "FLOW_INVALID",
        _message: `Flow missing _steps: ${flow_id}`
      }).toXData();
    }

    _xlog.debug(`[flow] run ${flow_id} (app=${app_id}, env=${env})`);
    _xlog.debug("[flow] ctx", ctx);

    _xem.fire("flow:start", { flow_id, app_id, env, ctx });

    /* ---------------------------------------------------------------------- */
    /* EXECUTION                                                              */
    /* ---------------------------------------------------------------------- */

    let last_result: any = null;
    let flow_failed_result: any = null;

    for (let i = 0; i < flow._steps.length; i++) {
      const step = flow._steps[i];

      _xlog.debug(`[flow] step ${step._id ?? "unknown"}`);

      _xem.fire("flow:step", {
        flow_id,
        app_id,
        env,
        step_id: step._id,
        step_index: i,
        ctx
      });

      /* ---------------- condition ---------------- */

      if (step._when && !this.check_when(step._when, ctx)) {
        _xlog.debug(`[flow] skip ${step._id ?? "unknown"}`);
        continue;
      }

      /* ---------------- validation ---------------- */

      if (!step._command?._module || !step._command?._op) {
        return new XResponseError({
          _code: "FLOW_INVALID_STEP",
          _message: `Invalid command in step ${step._id ?? "unknown"}`
        }).toXData();
      }

      if (step._output && !step._output?._to?._key) {
        return new XResponseError({
          _code: "FLOW_INVALID_OUTPUT",
          _message: `Invalid _output in step ${step._id ?? "unknown"}`
        }).toXData();
      }

      const raw_params = step._command._params;

      if (raw_params && typeof raw_params !== "object") {
        return new XResponseError({
          _code: "FLOW_INVALID_PARAMS",
          _message: `Invalid _params in step ${step._id ?? "unknown"}`
        }).toXData();
      }

      /* ---------------- resolve input ------------ */

      const resolved_params: Record<string, any> = {};

      for (const key of Object.keys(raw_params || {})) {
        resolved_params[key] = this.resolve_any(raw_params![key], ctx);
      }

      Object.assign(resolved_params, this.resolve_input(step._input, ctx));

      _xlog.debug("[flow] resolved_params", resolved_params);

      /* ---------------- execute ------------------ */

      let result: any;

      try {
        const raw = await _x.execute({
          _module: step._command._module,
          _op: step._command._op,
          _object: step._command._object,
          _params: resolved_params
        });

        result =
          raw && typeof raw === "object" && "_ok" in raw
            ? raw
            : { _ok: true, _result: raw };
      } catch (err) {
        return new XResponseError({
          _code: "FLOW_STEP_ERROR",
          _message: `Step failed: ${step._id ?? "unknown"}`,
          _details: err
        }).toXData();
      }

      last_result = result;
      ctx.step_results[step._id ?? `step_${i}`] = result;

      _xlog.debug("[flow] step result", result);
      _xlog.debug("[flow] ctx", ctx);

      /* ---------------- output ------------------- */

      if (step._output && result?._ok !== false) {
        let value = result;

        if (step._output._value !== undefined) {
          value = this.resolve_any(step._output._value, ctx);
        }

        outputs[step._output._to._key] = value;
      }

      /* ---------------- stop on error ------------ */

      if (result?._ok === false) {
        flow_failed_result = result;
        break;
      }
    }

    const flow_ok = !flow_failed_result;

    _xem.fire("flow:end", {
      flow_id,
      app_id,
      env,
      _ok: flow_ok,
      result: last_result,
      ctx
    });

    /* ---------------------------------------------------------------------- */
    /* RESPONSE                                                               */
    /* ---------------------------------------------------------------------- */

    if (flow_failed_result) {
      return new XResponseError({
        _code: "FLOW_STEP_RETURNED_ERROR",
        _message: `Flow step returned error in flow ${flow_id}`,
        _details: flow_failed_result,
        _flow: {
          _outputs: outputs,
          _last: last_result
        }
      }).toXData();
    }

    return new XResponseOK({
      _flow: {
        _outputs: outputs,
        _last: last_result
      }
    }).toXData();
  }

  /* ------------------------------------------------------------------------ */
  /* HELPERS                                                                  */
  /* ------------------------------------------------------------------------ */

  private get_by_path(obj: any, path: string): any {
    if (!obj || typeof path !== "string") return undefined;

    const parts = path.split(".").filter(Boolean);
    let cur = obj;

    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }

    return cur;
  }

  private resolve_any(val: any, ctx: any): any {
    if (typeof val === "string") return this.resolve_value(val, ctx);

    if (Array.isArray(val)) {
      return val.map((item) => this.resolve_any(item, ctx));
    }

    if (val && typeof val === "object") {
      const out: Record<string, any> = {};

      for (const key of Object.keys(val)) {
        out[key] = this.resolve_any(val[key], ctx);
      }

      return out;
    }

    return val;
  }

  private resolve_value(val: any, ctx: any) {
    if (typeof val !== "string" || !val.startsWith("$")) return val;

    if (val.startsWith("$event.")) {
      return this.get_by_path(ctx.event, val.slice(7));
    }

    if (val.startsWith("$xdata.")) {
      return _xd.get(val.slice(7));
    }

    if (val.startsWith("$step.")) {
      return this.get_by_path(ctx.step_results, val.slice(6));
    }

    return val;
  }

  private resolve_input(input: XFlowStep["_input"] | undefined, ctx: any) {
    if (!input) return {};

    const out: Record<string, any> = {};

    for (const key of Object.keys(input)) {
      const def = input[key];

      if (def._from === "xdata") {
        out[key] = _xd.get(def._key);
      }
    }

    return out;
  }

  private check_when(cond: XFlowStep["_when"], ctx: any): boolean {
    if (!cond) return true;

    let val;

    if (typeof cond._key === "string" && cond._key.startsWith("$")) {
      val = this.resolve_value(cond._key, ctx);
    } else {
      val =
        cond._type === "xdata"
          ? _xd.get(cond._key)
          : cond._type === "event"
          ? this.get_by_path(ctx.event, cond._key)
          : undefined;
    }

    if (cond._equals !== undefined) return val === cond._equals;
    if (cond._not_equals !== undefined) return val !== cond._not_equals;

    return true;
  }
}

export default FlowManagerModule;