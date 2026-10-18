import test from 'node:test';
import assert from 'node:assert/strict';
import { mountedDescendants, assertUnmountedTree } from '../server/mount-safety.js';

test('deletion detects exact and escaped nested mounts while ignoring parent and sibling mounts', async () => {
  const inventory = '1 0 1:1 / / rw - ext4 /dev/vda1 rw\n2 1 7:1 / /data/server/worlds/My\\040world rw - ext4 /dev/loop1 rw\n3 1 7:2 / /data/server-two rw - ext4 /dev/loop2 rw\n';
  assert.deepEqual(mountedDescendants(inventory, '/data/server'), ['/data/server/worlds/My world']);
  await assert.rejects(assertUnmountedTree('/data/server', { platform: 'linux', readFile: async () => inventory }), error => error.code === 'MOUNTED_TREE');
  await assertUnmountedTree('/data/server/worlds/Other', { platform: 'linux', readFile: async () => inventory });
  assert.throws(() => mountedDescendants('bad mount inventory', '/data/server'));
});
