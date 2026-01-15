// Settings.ts
// Module to manage server properties with real-time updates from a JSON file

import { _XEventManager } from "../XEM/XEventManager.js";
import * as fs from 'fs';
import * as path from 'path';
import { _xu } from "../XNUtils/XUtils.js";






const XSettingsFolder = "settings";

export class _XSettings extends _XEventManager {
    private filePath!: string;
    private data: Record<string, any> = {};
    private watcher?: fs.FSWatcher;

    constructor() {
        super();
    }

    onSetup(workFolder: string = ".work") {
        const settingsFolderPath = path.join(workFolder, "settings");
        _xu.checkFolders([settingsFolderPath]);
        const jsonFilePath: string = path.join( settingsFolderPath, "server-settings.json");
        this.filePath = path.resolve(jsonFilePath);
        this.save();
        this.watch();
    }

    init(workFolder: string = ".work") {
        const settingsFolderPath = path.join(workFolder, "settings");
        const jsonFilePath: string = path.join( settingsFolderPath, "server-settings.json");
        this.load(jsonFilePath);
    }


    load(jsonFilePath: string) {
        try {
            this.filePath = path.resolve(jsonFilePath);
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            this.data = JSON.parse(raw);
            this.fire('update', this.data);
        } catch (err) {
            this.fire('error', err);
        }
        this.watch();
    }

    private watch() {
        if (this.watcher) this.watcher.close();
        this.watcher = fs.watch(this.filePath, (eventType) => {
            if (eventType === 'change') {
                this.load(this.filePath);
            }
        });
    }

    public get(key: string) {
        return this.data[key];
    }

    public set(key: string, value: any) {
        this.data[key] = value;
        this.save();
    }

    public has(key: string): boolean {
        return this.data.hasOwnProperty(key);
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
            this.fire('update', this.data);
        } catch (err) {
            this.fire('error', err);
        }
    }

    public getAll() {
        return { ...this.data };
    }

    public close() {
        if (this.watcher) this.watcher.close();
    }
}

export const XSettings = new _XSettings()
export const _xs = XSettings;
export default XSettings;