import { XModule, XResponseError, XResponseOK } from "../index.js";

export class PingModule extends XModule {
    constructor() {
        super({ _name: "ping" });
    }

    _ping(_params: Record<string, any> = {}, _ctx?: any) {
        try {
            const _result: Record<string, any> = {
                _reply: "pong",
                _ts: Date.now()
            };

            if (Object.prototype.hasOwnProperty.call(_params, "_echo")) {
                _result._echo = _params._echo;
            }

            const _response = new XResponseOK(_result);
            return _response.toXData();
        } catch (err) {
            const _message = err instanceof Error ? err.message : "Ping failed";
            const _error = new XResponseError(
                err instanceof Error ? err : new Error(_message)
            );
            _error._result = {
                _code: "E_PING",
                _message,
                _meta: { _op: "ping" }
            };
            return _error.toXData();
        }
    }
}
