import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
// OWASP scrypt option: N=2^15, r=8, p=3. No untrusted cost fields.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let activeHashes = 0;
const derive = async (password: string, salt: Buffer): Promise<Buffer> => {
  if (activeHashes >= 4) throw new Error("AUTH_BUSY");
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 64, options, (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  } finally {
    activeHashes--;
  }
};
export const isValidPasswordInput = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= 1024;
export const hashPassword = async (password: string) => {
  if (!isValidPasswordInput(password)) throw new Error("INVALID_PASSWORD");
  const salt = randomBytes(16);
  return `scrypt-v1$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
};
export const verifyPassword = async (
  password: string,
  account: { passwordHash?: unknown; password?: unknown },
) => {
  if (!isValidPasswordInput(password)) return false;
  if (account.passwordHash !== undefined) {
    if (
      typeof account.passwordHash !== "string" ||
      !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(account.passwordHash)
    )
      return false;
    const [, salt, stored] = account.passwordHash.split("$");
    return timingSafeEqual(
      await derive(password, Buffer.from(salt, "hex")),
      Buffer.from(stored, "hex"),
    );
  }
  if (
    process.env.ALLOW_LEGACY_PASSWORDS === "false" ||
    typeof account.password !== "string"
  )
    return false;
  // Read-only compatibility: do not rewrite an existing credential during login.
  const sha = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(sha(password), sha(account.password));
};
