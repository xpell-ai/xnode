// xnode/src/.../xutils.ts

import fs from "node:fs";
import { _xlog, _XUtils } from "@xpell/core";
import { Buffer } from "node:buffer";
import path from "node:path";

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

  pathJoin(...parts: string[]) {
    const jp = path.join(...parts);
    if (!jp.endsWith(path.sep)) return jp + path.sep;
    return jp;
  }

  copyDirRecursive(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, {
      withFileTypes: true
    });

    for (const entry of entries) {
      const src_path = path.join(src, entry.name);
      const dest_path = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirRecursive(
          src_path,
          dest_path
        );
      } else {
        fs.copyFileSync(
          src_path,
          dest_path
        );
      }
    }
  }

}

const XUtils = new _XNUtils();
const _xu = XUtils;

export { XUtils, _xu };
export default XUtils;
