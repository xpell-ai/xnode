// xnode/src/.../xutils.ts

import fs from "node:fs";
import { _xlog, _XUtils } from "xpell-core";
import { Buffer } from "node:buffer";

export class _XNUtils extends _XUtils {
  /**
   * Encode string to Base-64 format
   * @param str string to encode
   */
  encode(str: string): string {
    return Buffer.from(encodeURIComponent(str), "utf8").toString("base64");
  }

  /**
   * Decode Base64 String to text
   * @param str Base64 encoded string
   */
  decode(str: string): string {
    return decodeURIComponent(Buffer.from(str, "base64").toString("utf8"));
  }

  /**
   * Copy keys from source to target only when value is not null/undefined.
   * Keeps valid falsy values (0, false, "").
   */
  addIfNotNull(source: any, target: any, keys: string[]) {
    if (!source || !target || !Array.isArray(keys)) return;
    for (const k of keys) {
      const v = source[k];
      if (v !== undefined && v !== null) target[k] = v;
    }
  }

  /**
   * Checks if folders exist and creates them if not (supports nested folders)
   */
  checkFolders(folders: string[]) {
    if (!Array.isArray(folders)) return;

    for (const folderPath of folders) {
      if (!folderPath) continue;
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
        _xlog.log("Creating folder " + folderPath);
      }
    }
  }

  /**
   * Add Last Slash
   * adds a last slash to the url if it doesn't have one
   */
  als(url: string) {
    const s = String(url ?? "");
    return s.endsWith("/") ? s : s + "/";
  }

  /**
   * Clear Last Slash
   * removes the last slash if exists
   */
  cls(url: string) {
    const s = String(url ?? "");
    return s.endsWith("/") ? s.slice(0, -1) : s;
  }

  /**
   * Add First Slash
   */
  afs(url: string) {
    const s = String(url ?? "");
    return s.startsWith("/") ? s : "/" + s;
  }

  /**
   * Clear First Slash
   */
  cfs(url: string) {
    const s = String(url ?? "");
    return s.startsWith("/") ? s.slice(1) : s;
  }

  /**
   * Calculates expiration time based on short format:
   *  - 1h (hours)
   *  - 2d (days)
   *  - 3y (years, 365d)
   * Returns epoch ms (now + delta).
   */
  calculateExpiration(exp: string) {
    const s = String(exp ?? "").trim();
    const match = s.match(/^(\d+)([hdy])$/);
    if (!match) throw new Error("Invalid expiration format. Use: 1h | 2d | 3y");

    const quantity = Number.parseInt(match[1], 10);
    const unit = match[2] as "h" | "d" | "y";

    const now = Date.now();

    let addedTime = 0;
    switch (unit) {
      case "h":
        addedTime = quantity * 60 * 60 * 1000;
        break;
      case "d":
        addedTime = quantity * 24 * 60 * 60 * 1000;
        break;
      case "y":
        addedTime = quantity * 365 * 24 * 60 * 60 * 1000;
        break;
    }

    return now + addedTime;
  }
}

const XUtils = new _XNUtils();
const _xu = XUtils;

export { XUtils, _xu };
export default XUtils;
