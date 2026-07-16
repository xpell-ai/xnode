/**
 * XDBObject.ts — Base class for Mongo-backed XDB objects (Mongoose)
 *
 * ✅ Xpell-native fields: prefer _snake_case everywhere.
 * ✅ No platform-specific assumptions (no _space_id, no "spaces", no hardcoded collections).
 * ✅ Generic aggregation helper uses explicit join field names passed in options.
 */

import mongoose from "mongoose";
import type { Connection, IndexDefinition, IndexOptions } from "mongoose";
import bcrypt from "bcryptjs";

import { XObject, _xlog, type XObjectData, XResponse} from "@xpell/core";


const BCRYPT_SALT_OR_ROUNDS = 10;

type XIndex = { keys: IndexDefinition; options?: IndexOptions };

export type XDBObjectRawFindOptions = {
  _skip?: number;
  _limit?: number;
  _sort?: any;
  _no_ignore?: boolean;
};

export type XDBObjectRawWriteOptions = {
  _hash?: boolean;
  _no_ignore?: boolean;
};

export type XDBObjectAddRawOptions = XDBObjectRawWriteOptions & {
  _preserve_id?: boolean;
};

export type XDBObjectUpdateRawOptions = XDBObjectRawWriteOptions & {
  _upsert?: boolean;
};

export type XDBObjectProviderOptions = {
  _mongoose_connection?: Connection;
  _model_name?: string;
  _collection_name?: string;
  _throw_on_model_error?: boolean;
};

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

  protected _mongoose_connection?: Connection;
  protected _model_name?: string;
  protected _collection_name?: string;
  protected _throw_on_model_error = false;

  constructor(data: XObjectData) {
    super(data);
    this.parse(data);

    const providerOptions =
      data as XObjectData & XDBObjectProviderOptions;

    this._mongoose_connection =
      providerOptions._mongoose_connection;

    this._model_name =
      providerOptions._model_name;

    this._collection_name =
      providerOptions._collection_name;

    this._throw_on_model_error =
      providerOptions._throw_on_model_error === true;

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

  private shouldUseConnectionScopedModel() {
    return !!(
      this._mongoose_connection ||
      this._model_name ||
      this._collection_name
    );
  }

  private shouldThrowModelCreationErrors() {
    return (
      this._throw_on_model_error ||
      this.shouldUseConnectionScopedModel()
    );
  }

  private stableSchemaValue(value: any): any {
    if (typeof value === "function") {
      return `[Function:${value.name || "anonymous"}]`;
    }

    if (
      value === null ||
      typeof value !== "object"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.stableSchemaValue(item));
    }

    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = this.stableSchemaValue(value[key]);
    }
    return out;
  }

  private schemaSignature(schema: any) {
    return JSON.stringify(
      this.stableSchemaValue(schema ?? {})
    );
  }

  private modelCollectionName(model: any) {
    return (
      model?.collection?.name ??
      model?.collection?.collectionName ??
      model?.collectionName
    );
  }

  private assertConnectionScopedModelCompatible(
    modelName: string,
    existing: any,
    nextSchema: any,
    collectionName?: string
  ) {
    const existingCollection =
      this.modelCollectionName(existing);

    if (
      collectionName &&
      existingCollection &&
      existingCollection !== collectionName
    ) {
      throw new Error(
        `XDBObject model '${modelName}' already exists for collection '${existingCollection}', not '${collectionName}'`
      );
    }

    const existingSignature =
      existing?.schema?.__xdb_schema_signature ??
      this.schemaSignature(existing?.schema?.obj ?? {});

    const nextSignature =
      nextSchema?.__xdb_schema_signature ??
      this.schemaSignature(nextSchema?.obj ?? {});

    if (
      existing?.schema &&
      existingSignature !== nextSignature
    ) {
      throw new Error(
        `XDBObject model '${modelName}' already exists with an incompatible schema`
      );
    }
  }

  protected createModel() {
    const mongoSchema = new mongoose.Schema(<any>this._schema, {
      timestamps: true,
      autoIndex: true, // set false in prod if you manage indexes manually
    });

    (mongoSchema as any).__xdb_schema_signature =
      this.schemaSignature(this._schema);

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
      const modelName =
        String(
          this._model_name ??
          this._name
        );

      if (this.shouldUseConnectionScopedModel()) {
        if (!this._mongoose_connection) {
          throw new Error(
            "XDBObject connection-scoped model creation requires _mongoose_connection"
          );
        }

        const connection =
          this._mongoose_connection as any;

        const existing =
          connection.models?.[modelName] as mongoose.Model<any> | undefined;

        if (existing) {
          this.assertConnectionScopedModelCompatible(
            modelName,
            existing,
            mongoSchema,
            this._collection_name
          );
        }

        this._model =
          existing ??
          connection.model(
            modelName,
            mongoSchema,
            this._collection_name
          );
      } else {
        // Avoid OverwriteModelError during hot reloads for legacy callers.
        const existing = (mongoose.models as any)?.[modelName] as mongoose.Model<any> | undefined;

        const modelFactory = mongoose.model as any;
        this._model = existing ?? modelFactory(modelName, mongoSchema);
      }

      if (!this._model) {
        throw new Error(
          `XDBObject model '${modelName}' was not created`
        );
      }

      // Optional: sync indexes ONLY when explicitly enabled (dev)
      if (process.env.XDB_SYNC_INDEXES === "true") {
        void this._model.syncIndexes().catch((e: any) => {
          _xlog.error(`syncIndexes failed for ${this._name}: ${e?.message ?? e}`);
        });
      }

      return this._model;
    } catch (error: any) {
      _xlog.error(`XDB ERROR Creating Model for ${this._name}: ${error?.message ?? error}`);
      if (this.shouldThrowModelCreationErrors()) {
        throw error;
      }
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

  protected getModel() {
    if (!this._model) {
      throw new Error(
        `XDBObject model '${this._model_name ?? this._name}' is not initialized`
      );
    }

    return this._model as any;
  }

  protected async execModelQuery<T = any>(query: any): Promise<T> {
    if (
      query &&
      typeof query.exec === "function"
    ) {
      return await query.exec();
    }

    return await query;
  }

  protected cloneInput(data: any) {
    if (
      data === null ||
      data === undefined ||
      typeof data !== "object"
    ) {
      return data;
    }

    return {
      ...data
    };
  }

  protected applyFindOptions(query: any, options: XDBObjectRawFindOptions = {}) {
    let out =
      query;

    if (
      options._sort &&
      typeof out?.sort === "function"
    ) {
      out = out.sort(options._sort);
    }

    if (
      typeof options._skip === "number" &&
      typeof out?.skip === "function"
    ) {
      out = out.skip(Math.max(0, options._skip));
    }

    if (
      typeof options._limit === "number" &&
      typeof out?.limit === "function"
    ) {
      out = out.limit(Math.max(0, options._limit));
    }

    return out;
  }

  normalizeRecord(dbRecord?: any, noIgnore?: boolean) {
    const out =
      this.toXData(dbRecord, noIgnore);

    delete out.__v;
    delete out.$__;
    delete out._doc;

    return out;
  }

  async addRaw(data: any, options: XDBObjectAddRawOptions = {}) {
    const input =
      this.cloneInput(data ?? {});

    if (
      options._preserve_id === false &&
      input &&
      typeof input === "object"
    ) {
      delete input._id;
    }

    const dbModel =
      new (this.getModel())();

    const fixedData =
      await this.fixFields(
        input ?? {},
        options._hash !== false
      );

    Object.assign(
      dbModel,
      fixedData
    );

    const mongoObj =
      await dbModel.save();

    return this.normalizeRecord(
      mongoObj,
      options._no_ignore
    );
  }

  async findRaw(
    filter: any = {},
    options: XDBObjectRawFindOptions = {}
  ): Promise<any[]> {
    const fout =
      await this.fixFields(filter ?? {});

    const query =
      this.applyFindOptions(
        this.getModel().find(fout),
        options
      );

    const arrIn =
      await this.execModelQuery<any[]>(query);

    return Array.isArray(arrIn)
      ? arrIn.map((rec) =>
        this.normalizeRecord(
          rec,
          options._no_ignore
        )
      )
      : [];
  }

  async findOneRaw(
    filter: any,
    options: Pick<XDBObjectRawFindOptions, "_no_ignore"> = {}
  ) {
    const fout =
      await this.fixFields(filter ?? {});

    const dbOut =
      await this.execModelQuery<any>(
        this.getModel().findOne(fout)
      );

    return dbOut == null
      ? null
      : this.normalizeRecord(
        dbOut,
        options._no_ignore
      );
  }

  async countRaw(filter: any = {}) {
    const fout =
      await this.fixFields(filter ?? {});

    const count =
      await this.execModelQuery<number>(
        this.getModel().countDocuments(fout)
      );

    return Number(count ?? 0);
  }

  async updateOneRaw(
    filter: any,
    updates: any,
    options: XDBObjectUpdateRawOptions = {}
  ) {
    const fout =
      await this.fixFields(filter ?? {});

    const uout =
      await this.fixFields(
        this.cloneInput(updates ?? {}),
        options._hash !== false
      );

    const modelResult =
      await this.execModelQuery<any>(
        this.getModel()
          .findOneAndUpdate(
            fout,
            uout,
            {
              new: true,
              upsert: options._upsert ?? false,
            }
          )
      );

    return modelResult
      ? this.normalizeRecord(
        modelResult,
        options._no_ignore
      )
      : null;
  }

  async updateManyRaw(
    filter: any,
    updates: any,
    options: XDBObjectRawWriteOptions = {}
  ) {
    const fout =
      await this.fixFields(filter ?? {});

    const uout =
      await this.fixFields(
        this.cloneInput(updates ?? {}),
        options._hash !== false
      );

    const result =
      await this.execModelQuery<any>(
        this.getModel().updateMany(fout, uout)
      );

    return {
      _matched:
        Number(
          result?.matchedCount ??
          result?.n ??
          0
        ),
      _modified:
        Number(
          result?.modifiedCount ??
          result?.nModified ??
          0
        )
    };
  }

  async deleteManyRaw(filter: any) {
    const fout =
      await this.fixFields(filter ?? {});

    const result =
      await this.execModelQuery<any>(
        this.getModel().deleteMany(fout)
      );

    return {
      _deleted:
        Number(
          result?.deletedCount ??
          result?.n ??
          0
        )
    };
  }

  async distinctRaw(field: string, filter: any = {}) {
    const fout =
      await this.fixFields(filter ?? {});

    const arrIn =
      await this.execModelQuery<any[]>(
        this.getModel().distinct(field, fout)
      );

    return Array.isArray(arrIn)
      ? arrIn
      : [];
  }

  // ----------------------------------------------------------------------------
  // CRUD
  // ----------------------------------------------------------------------------

  async add(data: any) {
    const res = new XResponse();

    try {
      res._result =
        await this.addRaw(
          data,
          {
            _preserve_id: false
          }
        );
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
      res._result =
        await this.findRaw(
          filter,
          {
            _no_ignore:
              noIgnore
          }
        );
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
      const arrIn =
        await this.findRaw(
          filter,
          {
            _no_ignore:
              noIgnore
          }
        );

      if (Array.isArray(arrIn)) {
        res._result = arrIn.length === 1 ? arrIn[0] : arrIn;
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
      const arrIn =
        await this.distinctRaw(
          field,
          filter
        );

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
      const dbOut =
        await this.findOneRaw(
          {
            _id:
              objId
          },
          {
            _no_ignore:
              noIgnore
          }
        );

      if (dbOut != null) {
        res._result = dbOut;
        res._ok = true;
      } else {
        res._result = `${this.getModel().name} Entity Not Found`;
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
      res._result =
        await this.updateOneRaw(
          filter,
          updates,
          {
            _upsert:
              opts?.upsert,
            _no_ignore:
              noIgnore
          }
        );
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
      const result =
        await this.deleteManyRaw(filter);

      res._result = {
        acknowledged:
          true,
        deletedCount:
          result._deleted
      };
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
