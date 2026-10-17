import { getServerDatabaseConfiguration } from "./serverDatabase";
type Environment = Record<string, string | undefined>;

/** Keep the legacy development default until existing sessions are migrated. */
export const getJwtSecret = (
  environment: Environment = process.env,
): string => {
  const secret = environment.JWT_SECRET;

  if (environment.NODE_ENV === "production") {
    if (
      !secret ||
      Buffer.byteLength(secret.trim(), "utf8") < 32 ||
      /^(secret|changeme|change-me|password|your[-_ ]?secret)$/i.test(
        secret.trim(),
      )
    ) {
      throw new Error(
        "Production requires JWT_SECRET with at least 32 bytes. Generate a random secret and configure it on the server.",
      );
    }
  }

  return secret || "secret";
};

export const assertRuntimeConfiguration = (
  environment: Environment = process.env,
) => {
  getJwtSecret(environment);
  getServerDatabaseConfiguration(environment);
};
