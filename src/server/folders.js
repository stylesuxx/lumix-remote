// The PC's folders as the page's folder browser sees them.
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export class InvalidFolderError extends Error {}

export function expandHome(directory) {
  if (directory === '~') {
    return homedir();
  }

  if (directory.startsWith('~/')) {
    return path.join(homedir(), directory.slice(2));
  }

  return directory;
}

// Subfolders of a directory, hidden ones excluded, with its parent and the home folder.
export async function listDirectories(directory) {
  const resolved = path.resolve(expandHome(directory || '~'));
  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (error) {
    throw new InvalidFolderError(`cannot open ${resolved}: ${error.message}`);
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(resolved);

  return { path: resolved, parent: parent === resolved ? null : parent, home: homedir(), directories };
}

// Creates a folder inside a directory; the name must be a single path segment.
export async function createDirectory(directory, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed !== path.basename(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new InvalidFolderError(`invalid folder name: ${name}`);
  }

  const created = path.join(path.resolve(expandHome(directory)), trimmed);
  try {
    await mkdir(created);
  } catch (error) {
    throw new InvalidFolderError(`cannot create ${created}: ${error.message}`);
  }

  return created;
}
