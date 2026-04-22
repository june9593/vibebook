/**
 * In-repo data directory used by vibebook to store its index, salt, and book
 * index. Historically this was `.memvc/` (project's old name); a one-shot
 * migration in `migrateLegacyDataDir` renames legacy `.memvc/` → `.vibebook/`
 * on first sync/digest run.
 *
 * Use these helpers (not raw string literals) anywhere a path inside this
 * directory is needed, so the next rename is a one-line change.
 */
import { join } from "node:path";

export const REPO_DATA_DIR = ".vibebook";
export const LEGACY_REPO_DATA_DIR = ".memvc";

export const INDEX_REL = `${REPO_DATA_DIR}/index.json`;
export const BOOK_INDEX_REL = `${REPO_DATA_DIR}/index.book.json`;
export const REPO_SALT_REL = `${REPO_DATA_DIR}/repo-salt.json`;

export function dataDirAbs(repoPath: string): string {
  return join(repoPath, REPO_DATA_DIR);
}

export function indexAbs(repoPath: string): string {
  return join(repoPath, INDEX_REL);
}

export function bookIndexAbs(repoPath: string): string {
  return join(repoPath, BOOK_INDEX_REL);
}

export function repoSaltAbs(repoPath: string): string {
  return join(repoPath, REPO_SALT_REL);
}
