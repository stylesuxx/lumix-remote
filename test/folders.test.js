import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDirectory, InvalidFolderError, listDirectories } from '../src/server/folders.js';

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lumix-remote-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

test('lists visible subfolders sorted by name, with the parent', async (context) => {
  const root = await temporaryDirectory(context);
  for (const name of ['beta', 'Alpha', '.hidden']) {
    await mkdir(path.join(root, name));
  }

  const listing = await listDirectories(root);

  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.deepEqual(listing.directories, ['Alpha', 'beta']);
});

test('creates a folder from a single name and rejects paths', async (context) => {
  const root = await temporaryDirectory(context);

  assert.equal(await createDirectory(root, ' shoot '), path.join(root, 'shoot'));
  await assert.rejects(createDirectory(root, '../escape'), InvalidFolderError);
  await assert.rejects(createDirectory(root, '..'), InvalidFolderError);
  await assert.rejects(createDirectory(root, ''), InvalidFolderError);
  await assert.rejects(createDirectory(root, 'shoot'), InvalidFolderError);
  await assert.rejects(listDirectories(path.join(root, 'missing')), InvalidFolderError);
});
