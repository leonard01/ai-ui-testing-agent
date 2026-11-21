import { listSavedFiles, findSavedFile } from "../../src/site-storage.js";

export async function listApprovedIds(savedDir: string): Promise<string[]> {
  return (await listSavedFiles(savedDir)).map((item) => item.id);
}

export async function approvedPath(savedDir: string, id: string): Promise<string> {
  return findSavedFile(savedDir, id);
}
