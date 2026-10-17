// Preserve Firebase priority metadata across conditional PUTs without exposing it
// in application records. REST format=export includes priorities in the snapshot.
export const decodeFirebaseExport = (value: any): any => {
  if (!value || typeof value !== "object") return value;
  if (Object.prototype.hasOwnProperty.call(value, ".value"))
    return decodeFirebaseExport(value[".value"]);
  if (Array.isArray(value)) return value.map(decodeFirebaseExport);
  const entries = Object.entries(value).filter(([key]) => key !== ".priority");
  const numericKeys = entries.every(([key]) => /^(0|[1-9]\d*)$/.test(key));
  const maxKey = numericKeys
    ? entries.reduce((max, [key]) => Math.max(max, Number(key)), -1)
    : -1;
  if (entries.length && numericKeys && maxKey < entries.length * 2) {
    const result = Array(maxKey + 1).fill(null);
    for (const [key, child] of entries)
      result[Number(key)] = decodeFirebaseExport(child);
    return result;
  }
  return Object.fromEntries(
    entries.map(([key, child]) => [key, decodeFirebaseExport(child)]),
  );
};
export const preserveFirebasePriorities = (previous: any, next: any): any => {
  if (next === null) return null;
  const priority =
    previous && typeof previous === "object"
      ? previous[".priority"]
      : undefined;
  if (typeof next !== "object")
    return priority === undefined
      ? next
      : { ".value": next, ".priority": priority };
  const value = Object.fromEntries(
    Object.entries(next).map(([key, child]) => [
      key,
      preserveFirebasePriorities(previous?.[key], child),
    ]),
  );
  if (priority !== undefined) value[".priority"] = priority;
  return value;
};
export const validateDatabaseValue = (value: unknown, depth = 0): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    !value ||
    typeof value !== "object" ||
    depth > 32 ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error("INVALID_DATABASE_VALUE");
  for (const [key, child] of Object.entries(value)) {
    if (
      !key ||
      /[.#$\[\]\/\\\u0000-\u001f\u007f]/.test(key) ||
      Buffer.byteLength(key, "utf8") > 768
    )
      throw new Error("INVALID_DATABASE_VALUE");
    validateDatabaseValue(child, depth + 1);
  }
};
