export type ContextObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is ContextObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneContextValue(value: unknown, activeObjects: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      throw new TypeError("Cannot deep-merge circular org-tree context arrays");
    }
    activeObjects.add(value);
    const cloned = value.map((entry) => cloneContextValue(entry, activeObjects));
    activeObjects.delete(value);
    return cloned;
  }

  if (isPlainObject(value)) {
    if (activeObjects.has(value)) {
      throw new TypeError("Cannot deep-merge circular org-tree context objects");
    }
    activeObjects.add(value);
    const cloned: ContextObject = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneContextValue(entry, activeObjects);
    }
    activeObjects.delete(value);
    return cloned;
  }

  return value;
}

function mergeContextValue(
  parentValue: unknown,
  childValue: unknown,
  activeObjects: WeakSet<object>,
): unknown {
  if (Array.isArray(parentValue) && Array.isArray(childValue)) {
    return [
      ...parentValue.map((entry) => cloneContextValue(entry, activeObjects)),
      ...childValue.map((entry) => cloneContextValue(entry, activeObjects)),
    ];
  }

  if (isPlainObject(parentValue) && isPlainObject(childValue)) {
    return deepMergeContext(parentValue, childValue, activeObjects);
  }

  return cloneContextValue(childValue, activeObjects);
}

export function deepMergeContext(
  parentContext: ContextObject,
  childContext: ContextObject,
  activeObjects: WeakSet<object> = new WeakSet<object>(),
): ContextObject {
  const merged: ContextObject = {};
  const keys = new Set([...Object.keys(parentContext), ...Object.keys(childContext)]);

  for (const key of keys) {
    if (!Object.hasOwn(childContext, key)) {
      merged[key] = cloneContextValue(parentContext[key], activeObjects);
      continue;
    }

    if (!Object.hasOwn(parentContext, key)) {
      merged[key] = cloneContextValue(childContext[key], activeObjects);
      continue;
    }

    merged[key] = mergeContextValue(parentContext[key], childContext[key], activeObjects);
  }

  return merged;
}
