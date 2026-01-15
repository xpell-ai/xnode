/**
 * Xpell CDN Node Server Module
 * 
 */



import {XModule, _xlog } from "xpell-core"



import path from "path"
import fs from "fs"



const _cdn_data_file_name = "cdn-data.json"
const _cdn_index_file_name = "cdn-index.json"
const _cdn_lru_file_name = "cdn-lru.json"


export type CDNIndex = {
    [uname:string]:CDNDataItem
}

export type CDNLru = {
    [id:string]:CDNDataItem
}

export type CDNDataItem = {
    _id:string,
    _d:number, //date created
    _l:number, //last access
    _h:number, //hits counter for LRU
    _file:string ,
    // _encoding: string,
    _mime_type: string,
    _size:number
    _uname?:string
    _exp?:string
}

export class _XCDNServer extends XModule {

    _cdn_index:CDNIndex 
    _cdn_lru:CDNLru
    _cdn_folder:string = path.resolve("data/cdn") + path.sep 
    constructor() {
        const data = { name: "xcdn" }
        super(<any>data)
        this._cdn_index = {}
        this._cdn_lru = {}
    }

    async load() {
        await this.loadIndex()
        await this.loadLru()
        await super.load()
    }

    async _info() {
        _xlog.log("xcdn module v 1.0.0")
    }


    deleteCDNFolder(id:string) {

        const folder = this._cdn_folder + id 
        
        if(fs.existsSync(folder)) {
            try {
                const uname = this.getCdnData(id)._uname
                fs.rmSync(this._cdn_folder + id,{recursive:true})
                delete this._cdn_index[uname]
                delete this._cdn_lru[id]
                fs.writeFileSync(this._cdn_folder + _cdn_index_file_name,JSON.stringify(this._cdn_index), 'utf-8')
                fs.writeFileSync(this._cdn_folder + _cdn_lru_file_name,JSON.stringify(this._cdn_lru), 'utf-8')

                return true
            } catch(err) {
                _xlog.error("Error deleting CDN folder: ",err)
                return false
            }
        }
        return false
    }

    writeCDNFile(cdnData:CDNDataItem,uname:string) {

        if(uname){
            if(this._cdn_index[uname]) {
                this.deleteCDNFolder(this._cdn_index[uname]._id)
            }
            this.indexFile(uname,cdnData)
        }
        const fileName = this._cdn_folder + cdnData._id + path.sep + _cdn_data_file_name 
        _xlog.log("Writing CDN File",fileName)
        try{
            fs.writeFileSync(fileName, JSON.stringify(cdnData), 'utf-8')
        }
        catch(err) {
            _xlog.error("Error writing CDN file: ",err)
        }
    }

    getCdnFilebyName(uname:string) {

        if(this._cdn_index[uname]) {
            const cdnData = this._cdn_index[uname]    
            const fileName = this._cdn_folder + cdnData._id + path.sep + _cdn_data_file_name
            
            if(fs.existsSync(fileName)) {
                try{
                    const dataStr = fs.readFileSync(fileName,"utf-8")
                    return JSON.parse(dataStr)
                }catch(err) {
                    _xlog.error("Error reading CDN file: ",err)
                    return "Error reading file"
                }
            }
        }
        return "File not found"
    }

    getCdnData(id:string) {
        const fileName = this._cdn_folder + id + path.sep + _cdn_data_file_name     
        if(fs.existsSync(fileName)) {
            try{
                const dataStr = fs.readFileSync(fileName,"utf-8")
                return JSON.parse(dataStr)

            }catch(err) {
                _xlog.error("Error reading CDN file: ",err)
                return "Error reading file"
            }
        }
        else {
            return "File not found"
        }
    }


    indexFile(uname:string,data:CDNDataItem) {
        if(uname) {
            this._cdn_index[uname] = data

            fs.writeFile(this._cdn_folder + _cdn_index_file_name,JSON.stringify(this._cdn_index),(err) => {
                if (err) throw err;
            })
            
        }
    }

    loadIndex(){
        const cdnIndexFile = this._cdn_folder + _cdn_index_file_name
        _xlog.log("Loading CDN Index",cdnIndexFile)
        if(fs.existsSync(cdnIndexFile)){
            try {
                const indexDataStr = fs.readFileSync(cdnIndexFile,"utf-8")
                this._cdn_index = JSON.parse(indexDataStr)
                _xlog.log("CDN Index loaded")
            } catch(err) {
                _xlog.error("Error loading CDN Index: ",err)
            }
        }
    }

    loadLru(){
        const cdnLruFile = this._cdn_folder + _cdn_lru_file_name
        _xlog.log("Loading CDN LRU",cdnLruFile)
        if(fs.existsSync(cdnLruFile)){
            try {
                const lruDataStr = fs.readFileSync(cdnLruFile,"utf-8")
                this._cdn_lru = JSON.parse(lruDataStr)
                _xlog.log("CDN LRU loaded")
            } catch(err) {
                _xlog.error("Error loading CDN LRU: ",err)
            }
        }
    }

    updateLru(id:string) {
        if(this._cdn_lru[id]) {
            this._cdn_lru[id]._h++
            this._cdn_lru[id]._l = Date.now()
        }
        else {
            this._cdn_lru[id] = this.getCdnData(id)
            this._cdn_lru[id]._h++
            this._cdn_lru[id]._l = Date.now()
        }

        fs.writeFile(this._cdn_folder + _cdn_lru_file_name,JSON.stringify(this._cdn_lru),(err) => {
            if (err) throw err;
        })
    
    
    }


    /**
     * This function checks if the CDN file has expired(if an expiration date is set)
     * and deletes the file if it has expired
     * 
     * Note: exp == "-1" means the file expires upon first access
     * @param id CDN file id
     * @returns true if the file has expired or false if it has not
     */
    checkExp(id:string) {
        const cdnData = this.getCdnData(id)
        
        if(cdnData == "File not found") {
            return true
        }        
        if(cdnData._exp) {
            if(cdnData._exp == "-1") {
                this.deleteCDNFolder(id)
                return true
            }else {
                const expDate = new Date(cdnData._exp)
                if(expDate.getTime() < Date.now()) {
                    this.deleteCDNFolder(id)
                    return true
                }
            }
        }
        return false
    }
}

export const XCDNServer = new _XCDNServer()

export default XCDNServer
