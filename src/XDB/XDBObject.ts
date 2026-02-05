/**
 * XDBObject.ts — Base class for Mongo-backed XDB objects (Mongoose)
 *
 * ✅ Xpell-native fields: prefer _snake_case everywhere.
 * ✅ No platform-specific assumptions (no _space_id, no "spaces", no hardcoded collections).
 * ✅ Generic aggregation helper uses explicit join field names passed in options.
 */

import mongoose from "mongoose";
import type { IndexDefinition, IndexOptions } from "mongoose";
import bcrypt from "bcryptjs";

import { XObject, _xlog, type XObjectData, XResponse} from "@xpell/core";


const BCRYPT_SALT_OR_ROUNDS = 10;

type XIndex = { keys: IndexDefinition; options?: IndexOptions };

// Convert mongo camelCase keys to _xpell_snake_case when exporting.
// Example: createdAt -> _created_at
function toXpellCase(str: string) {
  return `_${str}`.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export type XDBJoin = {
  // Collection names
  from: string; // child collection name
  as: string;   // output array field name
  // Field mapping
  localField: string;
  foreignField: string;
  // Optional unwind (flatten)
  unwind?: boolean; // default true
};

export type XDBGrandchildrenQuery = {
  parentCollection: string;
  parentId: string;

  // 1st join: parent -> children
  childJoin: XDBJoin;

  // 2nd join: child -> grandchildren
  grandchildJoin: XDBJoin;

  // Pagination
  skip?: number;
  limit?: number;

  // Optional additional pipeline stages (advanced)
  pipelineBefore?: any[]; // runs after $match, before first $lookup
  pipelineAfter?: any[];  // runs at end, before skip/limit
};

export class XDBObject extends XObject {
  _schema?: any;

  // ignore on export
  protected _xdata_ignore_fields = ["__v", "_password", "password"];

  _model!: mongoose.Model<any>;

  /** optional indexes, can be provided via data._indexes or subclass static "indexes" */
  protected _indexes: XIndex[] = [];

  constructor(data: XObjectData) {
    super(data);
    this.parse(data);

    if (!this._name) {
      throw new Error("XDBObject: missing _name (collection/model name)");
    }

    // indexes may come from constructor data or subclass static
    const ctor: any = this.constructor;
    if ((data as any)?._indexes?.length) {
      this._indexes = (data as any)._indexes as XIndex[];
    } else if (Array.isArray(ctor?.indexes)) {
      this._indexes = ctor.indexes as XIndex[];
    }

    this["_type"] = "xdb-object";
    if (this._schema) this.createModel();
  }

  protected createModel() {
    const mongoSchema = new mongoose.Schema(<any>this._schema, {
      timestamps: true,
      autoIndex: true, // set false in prod if you manage indexes manually
    });

    // apply configured indexes (if any)
    if (Array.isArray(this._indexes)) {
      for (const idx of this._indexes) {
        if (!idx || !idx.keys) continue;
        try {
          mongoSchema.index(idx.keys as any, idx.options ?? {});
        } catch (e: any) {
          _xlog.error(`Error adding index on ${this._name}: ${e?.message ?? e}`);
        }
      }
    }

    try {
      // Avoid OverwriteModelError during hot reloads
      const existing = (mongoose.models as any)?.[this._name as string] as mongoose.Model<any> | undefined;

      const modelFactory = mongoose.model as any;
      this._model = existing ?? modelFactory(this._name, mongoSchema);

      // Optional: sync indexes ONLY when explicitly enabled (dev)
      if (process.env.XDB_SYNC_INDEXES === "true") {
        void this._model.syncIndexes().catch((e: any) => {
          _xlog.error(`syncIndexes failed for ${this._name}: ${e?.message ?? e}`);
        });
      }

      return this._model;
    } catch (error: any) {
      _xlog.error(`XDB ERROR Creating Model for ${this._name}: ${error?.message ?? error}`);
    }
  }

  /** Runtime: add a new index (updates schema + syncs with Mongo) */
  async addIndex(keys: IndexDefinition, options?: IndexOptions) {
    if (!this._model?.schema) throw new Error("Model not initialized");
    this._model.schema.index(keys as any, options ?? {});
    await this._model.syncIndexes();
    return { ok: true };
  }

  /** Runtime: list indexes from Mongo */
  async listIndexes() {
    return this._model.collection.indexes();
  }

  /** Runtime: drop a specific index by name */
  async dropIndex(name: string) {
    return this._model.collection.dropIndex(name);
  }

  /** Runtime: rebuild schema-defined indexes in Mongo */
  async rebuildIndexes() {
    await this._model.syncIndexes();
    return { ok: true };
  }

  async compareHashField(hash: string, plainText: string) {
    return await bcrypt.compare(plainText, hash);
  }

  /**
   * Keep keys AS-IS (Xpell-native snake_case).
   * If you ever want camelCase conversion, do it in one place (not here).
   */
  protected fixKey(key: string) {
    return key;
  }

  /**
   * Convert fields object keys to DB format.
   * ✅ Current rule: keep keys as-is (snake_case).
   * If checkXFields=true, applies hashing on schema fields marked with "_xhash".
   */
  protected async fixFields(data: { [k: string]: any }, checkXFields?: boolean) {
    const outData: { [k: string]: any } = {};
    for (const key of Object.keys(data ?? {})) {
      const fixedKey = this.fixKey(key);
      let dout = data[key];

      if (checkXFields) {
        const fieldSchema = this._schema?.[fixedKey];
        if (fieldSchema && fieldSchema["_xhash"]) {
          const salt = await bcrypt.genSalt(BCRYPT_SALT_OR_ROUNDS);
          dout = await bcrypt.hash(dout, salt);
        }
      }

      outData[fixedKey] = dout;
    }
    return outData;
  }

  // ----------------------------------------------------------------------------
  // CRUD
  // ----------------------------------------------------------------------------

  async add(data: any) {
    const res = new XResponse();

    try {
      const dbModel = new this._model();
      if (data && typeof data === "object") delete data._id;

      const fixedData = await this.fixFields(data ?? {}, true);
      Object.assign(dbModel, fixedData);

      const mongoObj = await dbModel.save();
      res._result = this.toXData(mongoObj);
      res._ok = true;
    } catch (e: any) {
      _xlog.error("XDBObject.add() error:", e);
      res._result = e?.message ?? e;
    }

    return res.toXData();
  }

  /** Search returning an ARRAY of XData objects */
  async searchArray(filter: any, noIgnore?: boolean) {
    const res = new XResponse();
    try {
      const fout = await this.fixFields(filter ?? {});
      const arrIn = await this._model.find(fout).exec();

      res._result = Array.isArray(arrIn) ? arrIn.map((rec) => this.toXData(rec, noIgnore)) : [];
      res._ok = true;
    } catch (e: any) {
      res._result = e?.message ?? e;
    }
    return res.toXData();
  }

  /**
   * Search returning either a single object (if exactly 1 match) or an array.
   * (If you prefer deterministic API, keep only searchArray + findOne.)
   */
  async search(filter: any, noIgnore?: boolean) {
    const res = new XResponse();
    try {
      const fout = await this.fixFields(filter ?? {});
      const arrIn = await this._model.find(fout).exec();

      if (Array.isArray(arrIn)) {
        res._result = arrIn.length === 1 ? this.toXData(arrIn[0], noIgnore) : arrIn.map((rec) => this.toXData(rec, noIgnore));
      } else {
        res._result = [];
      }

      res._ok = true;
    } catch (e: any) {
      res._result = e?.message ?? e;
    }

    return res.toXData();
  }

  async distinct(field: string, filter: any, _noIgnore?: boolean) {
    const res = new XResponse();
    try {
      const fout = await this.fixFields(filter ?? {});
      const arrIn = await this._model.distinct(field, fout).exec();

      res._result = (arrIn?.[0] ?? null)?.toString?.() ?? null;
      res._ok = true;
    } catch (e: any) {
      res._result = e?.message ?? e;
    }
    return res.toXData();
  }

  async findById(objId: string, noIgnore?: boolean) {
    const res = new XResponse();
    try {
      const dbOut = await this._model.findOne({ _id: objId }).exec();
      if (dbOut != null) {
        res._result = this.toXData(dbOut, noIgnore);
        res._ok = true;
      } else {
        res._result = `${this._model.name} Entity Not Found`;
      }
    } catch (e: any) {
      res._result = e?.message ?? e;
    }
    return res.toXData();
  }

  /**
   * Update (findOneAndUpdate)
   * Default: upsert=false (safer). Pass { upsert:true } if you want create-on-miss.
   */
  async update(filter: any, updates: any, noIgnore?: boolean, opts?: { upsert?: boolean }) {
    const res = new XResponse();
    try {
      const fout = await this.fixFields(filter ?? {});
      const uout = await this.fixFields(updates ?? {}, true);

      const modelResult = await this._model
        .findOneAndUpdate(fout, uout, {
          new: true,
          upsert: opts?.upsert ?? false,
        })
        .exec();

      res._result = modelResult ? this.toXData(modelResult, noIgnore) : null;
      res._ok = true;
    } catch (e: any) {
      _xlog.error("XDBObject.update() error:", e);
      res._result = e?.message ?? e;
    }
    return res.toXData();
  }

  async delete(filter: any) {
    const res = XResponse.create();
    try {
      const fout = await this.fixFields(filter ?? {});
      res._result = await this._model.deleteMany(fout).exec();
      res._ok = true;
    } catch (e: any) {
      res._result = e?.message ?? e;
    }
    return res.toXData();
  }

  // ----------------------------------------------------------------------------
  // Export
  // ----------------------------------------------------------------------------

  /**
   * Converts DB record to XData format
   * - preserves _snake_case
   * - converts non-underscore (camelCase) to _xpell_snake_case
   */
  toXData(dbRecord?: any, noIgnore?: boolean) {
    const dbOut = JSON.parse(JSON.stringify(dbRecord ?? {}));
    const out: { [k: string]: any } = {};

    for (const key of Object.keys(dbOut)) {
      if (!noIgnore && this._xdata_ignore_fields.includes(key)) continue;

      const skey = key.startsWith("_") ? key : toXpellCase(key);
      out[skey] = dbOut[key];
    }

    return out;
  }

  // ----------------------------------------------------------------------------
  // Generic aggregation: grandchildren (no "space" or "platform" assumptions)
  // ----------------------------------------------------------------------------

  /**
   * Generic helper:
   * parentCollection -> childJoin -> grandchildJoin
   *
   * Example:
   *  parentCollection: "platforms"
   *  childJoin: { from:"channels", localField:"_id", foreignField:"_platform_id", as:"children" }
   *  grandchildJoin: { from:"posts", localField:"children._id", foreignField:"_owner_entity_id", as:"grandchildren" }
   */
  async getGrandchildren(q: XDBGrandchildrenQuery): Promise<Array<any>> {
    const {
      parentCollection,
      parentId,
      childJoin,
      grandchildJoin,
      skip = 0,
      limit = 20,
      pipelineBefore = [],
      pipelineAfter = [],
    } = q;

    if (!mongoose.connection?.db) throw new Error("Mongo not connected");

    const pipeline: any[] = [
      { $match: { _id: new mongoose.Types.ObjectId(parentId) } },
      ...(Array.isArray(pipelineBefore) ? pipelineBefore : []),

      {
        $lookup: {
          from: childJoin.from,
          localField: childJoin.localField,
          foreignField: childJoin.foreignField,
          as: childJoin.as,
        },
      },

      ...(childJoin.unwind === false ? [] : [{ $unwind: `$${childJoin.as}` }]),

      {
        $lookup: {
          from: grandchildJoin.from,
          localField: grandchildJoin.localField,
          foreignField: grandchildJoin.foreignField,
          as: grandchildJoin.as,
        },
      },

      ...(grandchildJoin.unwind === false ? [] : [{ $unwind: `$${grandchildJoin.as}` }]),

      // return only grandchildren docs
      { $replaceRoot: { newRoot: `$${grandchildJoin.as}` } },

      ...(Array.isArray(pipelineAfter) ? pipelineAfter : []),

      { $skip: skip },
      { $limit: limit },
    ];

    return await mongoose.connection.db.collection(parentCollection).aggregate(pipeline).toArray();
  }
}

export default XDBObject;
