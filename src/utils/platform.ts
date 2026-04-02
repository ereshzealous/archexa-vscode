export const PLATFORM_KEY = `${process.platform}-${process.arch}`;

export const BINARY_NAME =
  process.platform === "win32" ? "archexa.exe" : "archexa";

/** Generate a random nonce string for Content Security Policy */
export function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length: 32 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}
