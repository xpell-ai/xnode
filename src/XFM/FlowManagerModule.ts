import { XModule, type XCommand, _x, _xd } from "@xpell/core";
import {_xem} from "../XEM/XEventManager.js";
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
  };

  _when?: {
    _type: "xdata";
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

    if (this._debug) {
      console.log(`[flow] run ${flow_id} (app=${app_id}, env=${env})`);
    }

    /* ---------------------------------------------------------------------- */
    /* LOAD FLOW                                                              */
    /* ---------------------------------------------------------------------- */

    const res = await _x.execute({
      _module: "server-xvm",
      _op: "get_flow",
      _params: { _app_id: app_id, _flow_id: flow_id, _env: env }
    });

    if (!res?._ok) {
      throw new Error(`Flow load failed: ${flow_id}`);
    }

    const flow: XFlow = res._result._flow;

    if (!Array.isArray(flow._steps)) {
      throw new Error(`Flow missing _steps: ${flow_id}`);
    }

    _xem.fire("flow:start", { flow_id, app_id, env });

    /* ---------------------------------------------------------------------- */
    /* EXECUTION                                                              */
    /* ---------------------------------------------------------------------- */

    let last_result: any = null;

    for (const step of flow._steps) {
      if (this._debug) {
        console.log(`[flow] step ${step._id ?? "unknown"}`);
      }

      _xem.fire("flow:step", {
        flow_id,
        step_id: step._id
      });

      /* ---------------- condition ---------------- */

      if (step._when && !this.check_when(step._when)) {
        continue;
      }

      /* ---------------- resolve input ------------ */

      const resolved_params = {
        ...(step._command._params || {}),
        ...this.resolve_input(step._input)
      };

      /* ---------------- execute ------------------ */

      let result: any;

      try {
        result = await _x.execute({
          _module: step._command._module,
          _op: step._command._op,
          _object: step._command._object,
          _params: resolved_params
        });
      } catch (err) {
        return {
          _ok: false,
          _error: {
            _code: "FLOW_STEP_ERROR",
            _message: `Step failed: ${step._id ?? "unknown"}`,
            _details: err
          }
        };
      }

      last_result = result;

      /* ---------------- output ------------------- */

      if (step._output && result?._ok !== false) {
        const key = step._output._to._key;
        _xd.set(key, result, { source: "flow" });
      }

      /* ---------------- stop on error ------------ */

      if (result?._ok === false) {
        break;
      }
    }

    _xem.fire("flow:end", { flow_id });

    return {
      _ok: true,
      _result: last_result
    };
  }

  /* ------------------------------------------------------------------------ */
  /* HELPERS                                                                  */
  /* ------------------------------------------------------------------------ */

  private resolve_input(input?: XFlowStep["_input"]) {
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

  private check_when(cond: XFlowStep["_when"]): boolean {
    if (!cond) return true;

    if (cond._type === "xdata") {
      const val = _xd.get(cond._key);

      if (cond._equals !== undefined) return val === cond._equals;
      if (cond._not_equals !== undefined) return val !== cond._not_equals;
    }

    return true;
  }
}

export default FlowManagerModule;