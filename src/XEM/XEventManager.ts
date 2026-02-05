/**
 * xnode/src/XEventManager.ts
 *
 * XEventManager — Node Adapter for Xpell Core XEM
 *
 * Contract:
 * - on(event, cb, { _once, _owner, _tag, _support_node? }, owner?) => listenerId
 * - once(event, cb, owner?) => listenerId
 * - fire(event, ...args) => Promise<void>
 * - remove(listenerId)
 * - removeOwner(owner)
 * - clear()
 *
 * Notes:
 * - Core runtime bus is canonical.
 * - Optional Node bridge exists but is OFF by default.
 * - Legacy compatibility:
 *   - on(event, cb, { _once }, owner) still works (core resolves owner)
 *   - fire(event, data, support_node_boolean) supported here (last arg boolean)
 */

import { _xlog } from "@xpell/core";

import {
  _XEventManager as _XEventManagerBase,
  type XEventListenerOptions as XEventListenerOptionsBase,
} from "@xpell/core";

import { EventEmitter } from "node:events";

export type XEventListenerOptions = XEventListenerOptionsBase & {
  /**
   * xnode-only:
   * When true, also registers a Node EventEmitter listener.
   * Default is false to prevent duplicate handling (core + node).
   */
  _support_node?: boolean;
  _owner?: any;
  _tag?: string;
};

type NodeListenerIndex = Record<
  string,
  {
    event_name: string;
    listener: (...args: any[]) => void;
    emitter: EventEmitter;
  }
>;

export class _XEventManager extends _XEventManagerBase {
  protected _node_emitter: EventEmitter;
  protected _node_index: NodeListenerIndex = {};

  constructor(emitter?: EventEmitter) {
    super();
    this._node_emitter = emitter ?? new EventEmitter();
  }

  /**
   * Optional: expose the Node emitter (for integrations / diagnostics).
   * Prefer using the core bus unless you have a specific reason.
   */
  getNodeEmitter(): EventEmitter {
    return this._node_emitter;
  }

  override on(
    event_name: string,
    listener: Function,
    options: XEventListenerOptions = {},
    owner?: any
  ): string {
    // normalize options for core (owner resolution is also done in core, but we keep it explicit)
    const coreOptions = {
      ...(options as any),
      _owner: (options as any)?._owner ?? owner,
    } as XEventListenerOptionsBase;

    // 1) canonical: register with core bus
    const id = super.on(event_name, listener, coreOptions);

    // 2) optional node bridge
    const supportNode = options?._support_node === true; // default OFF
    if (!supportNode) return id;

    const nodeListener = (...args: any[]) => {
      try {
        listener(...args);
      } catch (e) {
        _xlog.error(e);
      }

      // mirror once behavior (in case emitter is used)
      if (options?._once) this.remove(id);
    };

    try {
      if (options?._once) this._node_emitter.once(event_name, nodeListener);
      else this._node_emitter.on(event_name, nodeListener);

      this._node_index[id] = {
        event_name,
        listener: nodeListener,
        emitter: this._node_emitter,
      };
    } catch (e) {
      _xlog.error(e);
    }

    return id;
  }

  override once(event_name: string, listener: Function, owner?: any): string {
    return this.on(event_name, listener, { _once: true, _owner: owner });
  }

  override remove(listener_id: string): void {
    // remove node-bridge listener if present
    const entry = this._node_index[listener_id];
    if (entry) {
      try {
        entry.emitter.removeListener(entry.event_name, entry.listener);
      } catch (e) {
        _xlog.error(e);
      }
      delete this._node_index[listener_id];
    }

    // canonical remove
    super.remove(listener_id);
  }

  /**
   * fire(event_name, ...args)
   * Legacy: fire(event_name, data, support_node_boolean)
   *
   * Canonical: always fires on core bus first.
   * Optional: also emit on node emitter when last arg is boolean true.
   */
  override async fire(event_name: string, ...args: any[]): Promise<void> {
    // legacy support: allow last arg to be boolean toggle
    let supportNode = false;
    if (args.length && typeof args[args.length - 1] === "boolean") {
      supportNode = Boolean(args.pop());
    }

    // 1) canonical runtime bus
    await super.fire(event_name, ...args);

    // 2) optional node bridge
    if (!supportNode) return;

    try {
      this._node_emitter.emit(event_name, ...args);
    } catch (e) {
      _xlog.error(e);
    }
  }

  /**
   * Cleanup any node bridge listeners owned by an owner.
   * Core removeOwner() will remove core listeners; we also need to
   * remove node bridge entries that share the same id.
   *
   * NOTE: This assumes ids removed by core.removeOwner() are not directly returned.
   * So we do a best-effort cleanup by scanning core events via protected access.
   * If you prefer strictness, add `removeOwner()` override in core that returns removed ids.
   */
  override removeOwner(owner: any): void {
    // First remove from core (canonical)
    super.removeOwner(owner);

    // Then best-effort cleanup of node bridge:
    // any id still in _node_index but no longer exists in core index should be removed.
    for (const id of Object.keys(this._node_index)) {
      // core keeps protected _listener_index; if you don’t want to rely on it,
      // you can just remove all node listeners for this owner by tagging them.
      const coreHasId = (this as any)?._listener_index?.[id];
      if (!coreHasId) this.remove(id);
    }
  }

  override clear(): void {
    // clear node bridge
    for (const id of Object.keys(this._node_index)) {
      try {
        const e = this._node_index[id];
        e.emitter.removeListener(e.event_name, e.listener);
      } catch (err) {
        _xlog.error(err);
      }
      delete this._node_index[id];
    }
    super.clear();
  }
}

export const XEventManager = new _XEventManager();
export const _xem = XEventManager;
export default XEventManager;
