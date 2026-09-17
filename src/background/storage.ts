/** Read one chrome.storage.local key with a typed result. */
export async function readLocal<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.local.get(key);
  return stored[key] as T | undefined;
}
