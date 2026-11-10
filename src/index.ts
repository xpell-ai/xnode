
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

export {
  XUtils,
  _xu,
  _XNUtils,
  type XNodeUtils,
} from "./XNUtils/XUtils.js";

export {
  XEventManager,
  XEventManager as _xem,
  type XEventListenerOptions,
  _XEventManager,
  XSettings as Settings,
  _xs,
  XSettings,
} from "@xpell/node-core";

export {
  XWebServer,
  type XWebRequest,
  type XWebRouteContributor,
} from "./XServer/XWebServer.js";
export { XNode, type XNodeOptions } from "./XServer/XNode.js";
export { bindEntityLocalUnit } from "./XEntityManager/XEntityManager.js";
export { bindEntityHistoricalImport } from "./XEntityManager/XEntityManager.js";
export { ENTITY_HISTORICAL_IMPORT_CAPABILITIES, ENTITY_HISTORICAL_IMPORT_RUNTIME } from "./XEntityManager/EntityHistoricalImport.js";
export type { EntityHistoricalImportManifest, EntityHistoricalImportBinding, EntityHistoricalImportUnit, BoundEntityHistoricalImport } from "./XEntityManager/EntityHistoricalImport.js";
export { ENTITY_HISTORICAL_IMPORT_BACKUP_CAPABILITIES, ENTITY_HISTORICAL_IMPORT_BACKUP_RUNTIME,
    backupEntityHistoricalImport, restoreEntityHistoricalImport, resumeEntityHistoricalImportRestore } from "./XEntityManager/EntityHistoricalBackup.js";
export type { EntityHistoricalBackupOptions, EntityHistoricalRestoreOptions, BoundEntityHistoricalRestore } from "./XEntityManager/EntityHistoricalBackup.js";
export { ENTITY_LOCAL_UNIT_CAPABILITIES, ENTITY_LOCAL_UNIT_HASH_CAPABILITIES } from "./XEntityManager/EntityLocalUnit.js";
export { ENTITY_LOCAL_UNIT_HASH_INPUT_CAPABILITIES, assertEntityLocalUnitHashCreateInput } from "./XEntityManager/EntityLocalUnit.js";
export type { EntityLocalUnit, EntityLocalUnitBinding, BoundEntityLocalUnit, EntityLocalUnitCapacityProfile, EntityLocalUnitCapacityLimits, EntityLocalUnitCapacity, EntityLocalUnitHashPolicy, EntityLocalUnitHashAcknowledgement } from "./XEntityManager/EntityLocalUnit.js";
export { ServerXVMModule } from "./XVM/ServerXVMModule.js";
export { default as ServerXVMModuleDefault } from "./XVM/ServerXVMModule.js";
export { XAppPackageService } from "./XAppPackage/XAppPackageService.js";
export {
  DEFAULT_XAPP_DOWNLOAD_CORS_ORIGINS,
  DEFAULT_XAPP_UPLOAD_MAX_BYTES,
  XAPP_CONTENT_TYPE,
  XAPP_DOWNLOAD_ROUTE,
  XAPP_UPLOAD_ROUTE,
  createXAppPackageTransferRouter,
  createXAppDownloadRouter,
} from "./XAppPackage/XAppDownloadTransfer.js";
export type {
  XAppDownloadTransfer,
  XAppPackageRefResolution,
  XAppPackageTransferRouterOptions,
  XAppUploadTransfer,
} from "./XAppPackage/XAppDownloadTransfer.js";
export type {
  XAppManifest,
  XAppManifestFile,
  XAppPackageFileKind,
  XAppPackageLimits,
  XAppValidationIssue,
} from "./XAppPackage/XAppManifest.js";
export {
  resolveProjectStage,
  type XVMProjectMemoryStage,
} from "./XVM/ProjectMemoryStage.js";

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
/* XAuth exports                                                              */
/* -------------------------------------------------------------------------- */
export * from "./XAuth/index.js";

/* -------------------------------------------------------------------------- */
/* Wormholes (public)                                                        */
/* -------------------------------------------------------------------------- */

export * from "./Wormholes/wh.index.js";


/***** XAI */
export * from "./XAI/index.js"

/***** XMUTATOR   */
export * from "./XMutator/index.js"

/***** XPLANNING   */
export * from "./XPlanning/index.js"

export { createFileServiceModule, FileServiceModule } from "@xpell/file-service/server";
export type {
  XpellFileRefV1,
  XpellFileResolveRequirements,
  XpellFileScopeContext,
} from "@xpell/file-service/server";
export type { XpellResolvedFileV1 } from "@xpell/file-service/server";
