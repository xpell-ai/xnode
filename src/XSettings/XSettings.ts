// Settings.ts
// Module to manage server properties with real-time updates from a JSON file

import { _xem } from "../XEM/XEventManager.js";
import * as fs from 'fs';
import * as path from 'path';
import { _xu } from "../XNUtils/XUtils.js";
import { _xlog } from "@xpell/core";






export class _XSettings {
    private filePath!: string;
    private data: Record<string, any> = {};
    private watcher?: fs.FSWatcher;

    constructor() {
    }

    onSetup(workFolder: string = ".work") {
        const settingsFolderPath = path.join(workFolder, "settings");
        _xu.checkFolders([settingsFolderPath]);

        this.filePath = path.resolve(
            path.join(settingsFolderPath, "server-settings.json")
        );

        const loaded = this.load(this.filePath);

        if (!loaded && !fs.existsSync(this.filePath)) {
            this.data = {};
            this.save();
        }

        this.watch();
    }

    init(workFolder: string = ".work") {
        this.onSetup(workFolder);
    }

    load(jsonFilePath: string): boolean {
        try {
            this.filePath = path.resolve(jsonFilePath);

            if (!fs.existsSync(this.filePath)) {
                return false;
            }

            const raw = fs.readFileSync(this.filePath, "utf-8").trim();

            if (!raw) {
                this.data = {};
            } else {
                this.data = JSON.parse(raw);
            }

            _xem.fire("settings:update", this.data);
            return true;
        } catch (err) {
            _xem.fire("settings:error", err);
            return false;
        }
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

    public getPath(path: string, fallback?: any): any {
        return _xu.get_path(this.data, path, fallback);
    }

    public setPath(path: string, value: any): void {
        _xu.set_path(this.data, path, value);
        this.save();
    }

    public hasPath(path: string): boolean {
        const missing = Symbol("xsettings.missing");
        return _xu.get_path(this.data, path, missing) !== missing;
    }

    public ensurePath(path: string, value: any): void {
        if (!this.hasPath(path)) {
            this.setPath(path, value);
        }
    }

    public ensure(key: string, value: any) {
        if (!this.has(key)) {
            this.set(key, value);
        }
    }

    public has(key: string): boolean {
        return this.data.hasOwnProperty(key);
    }

    public ensureDefaults(key: string, defaults: any) {
        const current = this.data[key] ?? {};
        const merged = _xu.deepMergeDefaults(current, defaults);

        if (JSON.stringify(current) !== JSON.stringify(merged)) {
            this.data[key] = merged;
            this.save();
        }
    }


    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
            _xem.fire('settings:update', this.data);
        } catch (err) {
            _xem.fire('settings:error', err);
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
