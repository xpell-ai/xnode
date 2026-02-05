import { _xlog } from "@xpell/core";
import type { XDBEngine } from "./XDBEngine.js";
import { XDB } from "./XDB.js";

const READY_ERROR = "XDB engine is not ready. Call XDB.init(...) and load the module before using XDB objects.";

export function assertXdbReady(): void {
    if (!XDB._engine || !XDB._engine._initialized) {
        _xlog.error(READY_ERROR);
        throw new Error(READY_ERROR);
    }
}

export function getXdbEngine(): XDBEngine {
    assertXdbReady();
    return XDB._engine;
}
