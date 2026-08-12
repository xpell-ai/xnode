import type { _XUtils } from "@xpell/core";
import {
  XUtils as NodeCoreXUtils,
  _xu as nodeCoreXu,
  _XNUtils,
} from "@xpell/node-core";

export type XNodeUtils = _XUtils & InstanceType<typeof _XNUtils>;

const XUtils =
  NodeCoreXUtils as XNodeUtils;

const _xu =
  nodeCoreXu as XNodeUtils;

export {
  XUtils,
  _xu,
  _XNUtils,
};

export default XUtils;
