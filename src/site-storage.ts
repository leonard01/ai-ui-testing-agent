import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

export const SAVED_NAME = /^reviewed-\d{13}-[a-f0-9]{8}\.json$/;

/** A suite is one normalized website ORIGIN, not an individual execution batch. */
export function websiteOrigin(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Test-suite URL must use HTTP(S) without credentials");
  }
  return url.origin;
}

/** Human-readable, collision-resistant and path-safe directory for one website. */
export function websiteFolder(raw: string): string {
  const site = websiteOrigin(raw);
  const url = new URL(site);
  const scheme = url.protocol.slice(0, -1);
  const host = url.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_").slice(0, 110);
  const hash = createHash("sha256").update(site).digest("hex").slice(0, 10);
  return scheme + "__" + host + "__" + hash;
}

export function websiteDirectory(savedDir: string, raw: string): string {
  return join(savedDir, "sites", websiteFolder(raw));
}

/**
 * Legacy tests live directly in savedDir. Newly approved cases live under
 * savedDir/sites/<website>/ without breaking legacy case IDs or JSON files.
 * Only regular files and direct site directories are read.
 */
export async function listSavedFiles(savedDir: string): Promise<Array<{ id: string; path: string }>> {
  const files: Array<{ id: string; path: string }> = [];
  let entries: Dirent[];
  try {
    entries = await readdir(savedDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && SAVED_NAME.test(entry.name)) {
      files.push({ id: entry.name, path: join(savedDir, entry.name) });
    }
  }
  let sites: Dirent[];
  try {
    sites = await readdir(join(savedDir, "sites"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const suite of sites) {
    if (!suite.isDirectory() || !/^(?:http|https)__[a-z0-9._-]+__[a-f0-9]{10}$/.test(suite.name)) {
      continue;
    }
    const path = join(savedDir, "sites", suite.name);
    const names = await readdir(path, { withFileTypes: true });
    for (const entry of names) {
      if (entry.isFile() && SAVED_NAME.test(entry.name)) {
        files.push({ id: entry.name, path: join(path, entry.name) });
      }
    }
  }
  return files.sort((a, b) => b.id.localeCompare(a.id));
}

export async function findSavedFile(savedDir: string, id: string): Promise<string> {
  if (!SAVED_NAME.test(id)) throw new Error("Invalid approved test filename");
  const match = (await listSavedFiles(savedDir)).find((file) => file.id === id);
  if (!match) throw new Error("Approved test not found");
  return match.path;
}
