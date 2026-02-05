import type { XResponse } from "@xpell/core";
import type { IXDBEmbeddingProvider } from "../XDBEngine.js";

type ExecFn = (cmd: any) => Promise<any>;

export class XpellEmbeddingProvider implements IXDBEmbeddingProvider {
    private _exec: ExecFn;
    private _moduleName: string;
    private _opName: string;

    constructor(exec: ExecFn, moduleName = "embeddings", opName = "embed-array") {
        this._exec = exec;
        this._moduleName = moduleName;
        this._opName = opName;
    }

    async embedArray(input: string[]): Promise<XResponse> {
        return await this._exec({
            _module: this._moduleName,
            _op: this._opName,
            _params: { _text: input },
        });
    }
}
