type Environment = Record<string, string | undefined>;

export const validateDatabaseUrl = (
  value: string,
  allowLoopback = false,
): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_SERVER_DATABASE_URL");
  }
  const firebaseHost =
    /^[a-z0-9-]+\.firebaseio\.com$/i.test(url.hostname) ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.firebasedatabase\.app$/i.test(url.hostname);
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (!loopback && !(firebaseHost && url.protocol === "https:" && !url.port))
  )
    throw new Error("INVALID_SERVER_DATABASE_URL");
  return url.origin;
};

export const getServerDatabaseConfiguration = (
  environment: Environment = process.env,
) => {
  const authMode =
    environment.FIREBASE_REST_AUTH_MODE ||
    (environment.NODE_ENV === "production" ? "google" : "anonymous");
  if (
    !["google", "anonymous"].includes(authMode) ||
    (environment.NODE_ENV === "production" && authMode !== "google")
  )
    throw new Error(
      "Production server database reads require Google credentials; invalid FIREBASE_REST_AUTH_MODE.",
    );
  const baseUrl = validateDatabaseUrl(environment.FIREBASE_databaseURL || "");
  return { baseUrl, authMode: authMode as "google" | "anonymous" };
};
