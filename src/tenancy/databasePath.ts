/** Validate raw Firebase keys before URL encoding; never decode a caller's path. */
export const validateRelativeDatabasePath = (value: string) => {
  if (
    typeof value !== "string" ||
    !value ||
    value
      .split("/")
      .some(
        (key) =>
          !key ||
          /[.#$\[\]\\\u0000-\u001f\u007f]/.test(key) ||
          Buffer.byteLength(key, "utf8") > 768,
      )
  )
    throw new Error("INVALID_DATABASE_PATH");
  return value;
};
