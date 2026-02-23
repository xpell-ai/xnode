
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

export {XUtils,XUtils as _xu } from "./XNUtils/XUtils.js"

export { XEventManager, XEventManager as _xem, type XEventListenerOptions, _XEventManager } from "./XEM/XEventManager.js";
// Settings module for server properties
export { XSettings as Settings } from "./XSettings/XSettings.js";

export { XWebServer } from "./XServer/XWebServer.js";
export { XNode } from "./XServer/XNode.js";
export { ServerXVMModule } from "./modules/ServerXVMModule.js";
export { default as ServerXVMModuleDefault } from "./modules/ServerXVMModule.js";
export type {
  XVMEnv,
  XVMView,
  XVMAppMeta,
  XVMAppFile,
  XVMAppBundle,
  SubscriberTarget,
  PushEventArgs,
  PushEventResult,
  ViewScope,
  ValidationCtx,
  ServerXVMModuleOptions,
} from "./modules/ServerXVMModule.js";

/* -------------------------------------------------------------------------- */
/* XDB exports (auto-discovered)                                              */
/* -------------------------------------------------------------------------- */

export { default as XDB } from "./XDB/XDB.js";
export { XDBModule } from "./XDB/XDB.js";
export type { XDBModuleInitOptions } from "./XDB/XDB.js";

export { default as XDBEngine } from "./XDB/XDBEngine.js";
export type { IXDBEmbeddingProvider, IXDBVectorQueryProvider } from "./XDB/XDBEngine.js";

export { default as XDBEntity } from "./XDB/XDBEntity.js";
export { default as XDBVector } from "./XDB/XDBVector.js";
export { default as XDBFile } from "./XDB/XDBFile.js";
export { default as XDBTemp } from "./XDB/XDBTemp.js";
export { default as XDBCache } from "./XDB/XDBCache.js";

export { default as XDBStorageFS } from "./XDB/XDBStorageFS.js";
export { default as XDBStorageSqlite } from "./XDB/XDBStorageSqlite.js";

export type { IXDBStorage, XDBData, XDBEntityPersisted } from "./XDB/IXDBStorage.js";
export type { IXDBMaintenance } from "./XDB/IXDBMaintenance.js";
export { XpellEmbeddingProvider } from "./XDB/providers/index.js";

/* -------------------------------------------------------------------------- */
/* Wormholes (public)                                                        */
/* -------------------------------------------------------------------------- */

export * from "./Wormholes/wh.index.js";
