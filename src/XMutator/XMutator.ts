import { _xlog } from "@xpell/core";

type XMutatorVisitState = {
  _found: boolean;
};

function is_object(
  value: any
): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

/**
 * Experimental manual integration helper.
 *
 * const mutator = new XMutator();
 * const next_view =
 *   mutator.replace_by_id(
 *     current_view,
 *     "title-label",
 *     {
 *       _id: "title-label",
 *       _type: "label",
 *       _text: "New Title"
 *     }
 *   );
 */
export class XMutator {
  replace_by_id(
    root: any,
    target_id: string,
    replacement: any
  ): any {
    _xlog.log("[xmutator] replace_by_id");

    const state: XMutatorVisitState = {
      _found: false
    };

    const result =
      this.clone_replace(root, target_id, replacement, state);

    if (state._found) {
      _xlog.log("[xmutator] target_found");
      _xlog.log("[xmutator] mutation_applied");
    } else {
      _xlog.log("[xmutator] target_missing");
    }

    return result;
  }

  find_by_id(
    root: any,
    target_id: string
  ): any | undefined {
    if (!is_object(root)) {
      return undefined;
    }

    if (!Array.isArray(root) && root._id === target_id) {
      return root;
    }

    if (Array.isArray(root)) {
      for (const item of root) {
        const found =
          this.find_by_id(item, target_id);

        if (found !== undefined) {
          return found;
        }
      }

      return undefined;
    }

    for (const value of Object.values(root)) {
      const found =
        this.find_by_id(value, target_id);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  has_id(
    root: any,
    target_id: string
  ): boolean {
    return this.find_by_id(root, target_id) !== undefined;
  }

  private clone_replace(
    value: any,
    target_id: string,
    replacement: any,
    state: XMutatorVisitState
  ): any {
    if (!is_object(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.clone_replace(item, target_id, replacement, state)
      );
    }

    if (value._id === target_id) {
      state._found =
        true;

      return this.clone(replacement);
    }

    const clone: Record<string, any> =
      {};

    for (const [key, child] of Object.entries(value)) {
      clone[key] =
        this.clone_replace(child, target_id, replacement, state);
    }

    return clone;
  }

  private clone(
    value: any
  ): any {
    if (!is_object(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.clone(item));
    }

    const clone: Record<string, any> =
      {};

    for (const [key, child] of Object.entries(value)) {
      clone[key] =
        this.clone(child);
    }

    return clone;
  }
}
