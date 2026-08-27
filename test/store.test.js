import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileSnapshotStore, MemorySnapshotStore } from '../src/store.js';
import { defineSnapshotStoreContract } from './support/snapshot-store-contract.js';

defineSnapshotStoreContract('MemorySnapshotStore', async () => new MemorySnapshotStore());

defineSnapshotStoreContract('JsonFileSnapshotStore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-economy-store-'));
  return new JsonFileSnapshotStore(path.join(dir, 'state.json'));
});
