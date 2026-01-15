
export { Xpell as _x } from "./Xpell/Xpell.js"
export { XUtils, XUtils as _xu } from "./Xpell/XUtils.js"
export { XData, XData as _xd, type XDataObject, type XDataVariable, _XData } from "./Xpell/XData.js"
export { XParser } from "./Xpell/XParser.js"
export { XCommand, type XCommandData } from "./Xpell/XCommand.js"
export { XLogger, XLogger as _xlog, _XLogger } from "./Xpell/XLogger.js"
export {
    XModule,
    type XModuleData,
    // GenericModule
} from "./Xpell/XModule.js"
export {
    XObject,
    XObjectPack,
    type IXData,
    type IXObjectData,
    type XDataXporterHandler,
    type XObjectData,
    type XObjectOnEventIndex,
    type XObjectOnEventHandler
} from "./Xpell/XObject.js"
export { XObjectManager } from "./Xpell/XObjectManager.js"
export { XEventManager, XEventManager as _xem, type XEventListener, type XEvent, type XEventListenerOptions, _XEventManager } from "./Xpell/XEventManager.js"
export { type XNanoCommandPack, type XNanoCommand } from "./Xpell/XNanoCommands.js"

// Settings module for server properties
export { XSettings as Settings } from "./Xpell/XSettings.js";

// Example usage (can be removed or moved to your server entry point)
// import { Settings } from './Settings';
// const settings = new Settings(__dirname + '/server-settings.json');
// settings.on('update', (data) => {
//     console.log('Settings updated:', data);
// });
// console.log('Current settings:', settings.getAll());

