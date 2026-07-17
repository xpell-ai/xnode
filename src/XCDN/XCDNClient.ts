

import {  _xlog } from "@xpell/core"
import { _xu } from "@xpell/node-core"
import  fetch, { Blob, FormData } from 'node-fetch'
import { readFile } from "node:fs/promises";


import fs from 'fs';
const CDNServices = {
    add: "/add/",
    get: "/get/",
    uget: "/u/",
}
const CDN_URL = (process.env.CDN_URL) ?process.env.CDN_URL : "http://localhost/"

export class XCDNClient {
    #_cdn_url: string = CDN_URL

    constructor(url?: string) {
        if (url) {
            this.#_cdn_url = url
        }
        _xlog.log("Aime CDN " + this.#_cdn_url + " is ready")
    }

    set CDNUrl(url: string) {
        if (!url.startsWith("http")) {
            url = "http://" + url
        }
        this.#_cdn_url = url
    }

    get CDNUrl() {
        if (this.#_cdn_url.endsWith("/")) {
            //remove last /
            this.#_cdn_url = this.#_cdn_url.substring(0, this.#_cdn_url.length - 1)
        }
        return this.#_cdn_url
    }

    async uploadFileOnce(fileNameWithPath: string,mimetype:string = "audio/mpeg" ): Promise<any> {
        const fileName = fileNameWithPath.split("/").pop()
        // const file = await fs.createReadStream(fileNameWithPath);
        // _xlog.log("Uploading file " + fileNameWithPath)
        const body = new FormData();
        const blob = new Blob([await readFile(fileNameWithPath)], { type: mimetype });
        

        body.set("cdn-file", blob, fileName);
        body.set("exp", "-1");
        
        const resp = await fetch(this.CDNUrl + CDNServices.add, {
          method: "POST",
          headers: {
            // "Content-Type": "multipart/form/-data",
            // "content-length": fs.statSync(fileNameWithPath).size.toString(),
            "mime-type": mimetype
          },
          body,
        })
        
        

        const res = await resp.json()
  
        return res
        
    }

    async uploadFileWithExp(fileNameWithPath: string,exp: string) : Promise<any> {
        const match = exp.match(/^(\d+)([hdy])$/);
        if (!match) {
            throw new Error('Invalid exp format');

        }

        const fileName = fileNameWithPath.split("/").pop()
        const body = new FormData();
        const blob = new Blob([await readFile(fileNameWithPath)]);
    
        body.set("cdn-file", blob, fileName);
        body.set("exp", exp);
        
        const resp = await fetch(this.CDNUrl + CDNServices.add, {
          method: "POST",
          headers: {
            // "Content-Type": "multipart/form/-data",
            // "content-length": fs.statSync(fileNameWithPath).size.toString(),
          },
          body,
        })
        
        const res = await resp.json()
  
        return res    
    
    }

    async uploadBase64(base64: string, mimetype:string,exp:string): Promise<any> {
        const buffer = Buffer.from(base64, 'base64')

        const body = new FormData();
        const blob = new Blob([buffer], { type: mimetype });
        let fileName = _xu.guid()
        
        if(mimetype == "image/png") {
            fileName += ".png"
        }
        
        body.set("cdn-file", blob, fileName);
        body.set("exp", exp);
        const url = this.CDNUrl + CDNServices.add
        
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            // "Content-Type": "multipart/form/-data",
            // "content-length": fs.statSync(fileNameWithPath).size.toString(),
            "mime-type": mimetype
          },
          body,
        })
        

        
        const res = await resp.json()
  
        return res
    }

    

    getUrl(cdnId: string) {
        return this.#_cdn_url + CDNServices.get + cdnId
    }

    getByUName(uname: string) {
        return this.#_cdn_url + CDNServices.uget + uname
    }
}


export const XCDN = new XCDNClient()
export default XCDN

