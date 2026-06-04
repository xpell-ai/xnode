
// export { XData, XData as _xd, _XData } from "@xpell/core"
// export { XParser } from "@xpell/core"
// export { XCommand, type XCommandData } from "@xpell/core"
// export { XLogger, XLogger as _xlog, _XLogger } from "@xpell/core"
// export {
//     XModule,
//     type XModuleData,
//     // GenericModule
// } from "@xpell/core"
// export {
//     XObject,
//     XObjectPack,
//     type IXData,
//     type XDataXporterHandler,
//     type XObjectData,
//     type XObjectOnEventIndex,
//     type XObjectOnEventHandler
// } from "@xpell/core"
// export { type XNanoCommandPack, type XNanoCommand } from "@xpell/core"
// export { XObjectManager } from "@xpell/core"
// export {XResponse,type XResponseData,XResponseError,XResponseOK} from "@xpell/core"

/* -------------------------------------------------------------------------- */
/* Core exports (SAFE + deterministic)                                        */
/* -------------------------------------------------------------------------- */

// 1) Export ALL core *types* (no runtime collisions)
// Core type surface (explicit = reliable)
export type {
  XValue,
  IXData,
  XObjectData,
  XDataXporter,
  XDataXporterHandler,
  XObjectOnEventIndex,
  XObjectOnEventHandler,
  XEventListener,
//   XEventListenerOptions, // EXCLUDED: exported from /xem/XEventManager
  XNanoCommandPack,
  XNanoCommand,
  XCommandData,
  XModuleData,
  XErrorOptions,
  XErrorLevel,
  XErrorMeta,
  XResponseData,
  XpellSkill,
  XpellSkillType,
  XpellSkillCommand,
  XpellSkillModule
} from "@xpell/core";


// 2) Export the core default (XpellEngine instance) as the DEFAULT of xpell-ui
//    If you prefer UI default (XUI) later, change this line.
export { default } from "@xpell/core";

// 3) Re-export core runtime symbols explicitly EXCEPT `_xem` / `XEventManager` / `_XEventManager`
//    because xpell-ui must expose the DOM-adapted event manager instead.
export {
  Xpell, _x,
 //   XUtils,_xu // EXCLUDED: re-exported below from ./XNUtils/XUtils
  XData,_xd,_XData,
  // type XDataObject,
  // type XDataVariable,
  XParser,
  XCommand,
  // type XCommandData,
  XLogger,
  _xlog,
  _XLogger,
  XModule,
  // type XModuleData,
  XObject,
  XObjectPack,
  XObjectManager,
  XParams,
  XError,
  XD_FRAME_NUMBER,
  XD_FPS,
  XpellEngine,
  XResponse, XResponseOK, XResponseError
} from "@xpell/core";

export {XUtils,_xu } from "./XNUtils/XUtils.js"

export { XEventManager, XEventManager as _xem, type XEventListenerOptions, _XEventManager } from "./XEM/XEventManager.js";
// Settings module for server properties
export { XSettings as Settings } from "./XSettings/XSettings.js";

export { XWebServer } from "./XServer/XWebServer.js";
export { XNode } from "./XServer/XNode.js";
export { ServerXVMModule } from "./XVM/ServerXVMModule.js";
export { default as ServerXVMModuleDefault } from "./XVM/ServerXVMModule.js";

export type {
  XVMEnv,
  XVMView,
  XVMAppMeta,
  XVMAppFile,
  XVMAppBundle,
} from "./XVM/ServerXVMModule.js";

/* -------------------------------------------------------------------------- */
/* XDB exports (auto-discovered)                                              */
/* -------------------------------------------------------------------------- */
export * from "./XDB/index.js";

/* -------------------------------------------------------------------------- */
/* Wormholes (public)                                                        */
/* -------------------------------------------------------------------------- */

export * from "./Wormholes/wh.index.js";


/***** XAI */
export * from "./XAI/index.js"

/***** XVIBE   */
export * from "./XVIBE/index.js"

/***** XMUTATOR   */
export * from "./XMutator/index.js"
