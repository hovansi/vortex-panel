import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { inspectBedrockWorld, BEDROCK_WORLD_LIMITS } from '../server/bedrock-world-format.js';

// All database bytes here are synthetic placeholders. Layout validation cannot
// establish LevelDB readability, a playable world or native BDS compatibility.
const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const short = value => { const bytes = Buffer.alloc(2); bytes.writeInt16LE(value); return bytes; };
const long = value => { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(value)); return bytes; };
const string = value => { const bytes = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16LE(bytes.length); return Buffer.concat([length, bytes]); };
const tag = (type, name, value) => Buffer.concat([Buffer.from([type]), string(name), value]);
const compound = children => Buffer.concat([...children, Buffer.from([0])]);
const list = (type, values) => Buffer.concat([Buffer.from([type]), int(values.length), ...values]);
const root = children => Buffer.concat([Buffer.from([10]), string(''), compound(children)]);
function level(body = root([]), version = 10) {
  const header = Buffer.alloc(8); header.writeUInt32LE(version, 0); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
async function fixture(t, bytes = level()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-world-format-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const world = path.join(directory, 'world');
  await fs.mkdir(path.join(world, 'db'), { recursive: true });
  await fs.writeFile(path.join(world, 'level.dat'), bytes);
  await fs.writeFile(path.join(world, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  await fs.writeFile(path.join(world, 'db', 'MANIFEST-000001'), 'Synthetic MANIFEST fixture; not a real LevelDB database.');
  await fs.writeFile(path.join(world, 'db', '000002.ldb'), 'Synthetic table fixture; not a playable Minecraft world.');
  return { directory, world };
}
async function fingerprints(directory, relative = '') {
  const result = {};
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprints(directory, filename));
    else result[filename] = createHash('sha256').update(await fs.readFile(path.join(directory, filename))).digest('hex');
  }
  return result;
}

test('Bedrock metadata inspection preserves opaque names and signed 64-bit seeds without changing bytes', async t => {
  const name = '\ufeffTệp tin · English <img src=x> & Save';
  const bytes = level(root([
    tag(8, 'LevelName', string(name)), tag(3, 'StorageVersion', int(10)),
    tag(4, 'RandomSeed', long('-9223372036854775808')), tag(4, 'LastPlayed', long(1791935126)),
    tag(9, 'lastOpenedWithVersion', list(3, [1, 26, 51, 1, 0].map(int))),
    tag(9, 'MinimumCompatibleClientVersion', list(3, [1, 26, 50, 0, 0].map(int))),
    tag(8, 'Secret', string('must not appear in metadata')), tag(3, '__proto__', int(7)),
  ]), 1234); // A newer header is not rejected merely because it is unfamiliar.
  const { world } = await fixture(t, bytes), before = await fingerprints(world);
  const result = await inspectBedrockWorld(world);
  assert.equal(result.name, name); assert.equal(result.displayName, name);
  assert.equal(result.seed, '-9223372036854775808'); assert.equal(result.storageVersion, 10);
  assert.equal(result.lastPlayed, new Date(1791935126000).toISOString());
  assert.deepEqual(result.lastOpenedVersion, [1, 26, 51, 1, 0]);
  assert.deepEqual(result.minimumCompatibleVersion, [1, 26, 50, 0, 0]);
  assert.equal(result.levelDatFormatVersion, 1234); assert.equal(result.fileCount, 4); assert.equal(result.entries, 5);
  assert.ok(result.bytes > bytes.length); assert.equal(result.size, result.bytes);
  assert.equal(result.validation, 'bedrock-metadata-and-leveldb-layout'); assert.deepEqual(result.warnings, []);
  assert.equal(JSON.stringify(result).includes('must not appear'), false); assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.deepEqual(await fingerprints(world), before);
});

test('the parser handles all standard NBT payload types and omits wrongly typed optional metadata', async t => {
  const float = Buffer.alloc(4); float.writeFloatLE(1.5);
  const double = Buffer.alloc(8); double.writeDoubleLE(-2.5);
  const bytes = level(root([
    tag(1, 'Byte', Buffer.from([255])), tag(2, 'Short', short(-123)), tag(3, 'Int', int(123)),
    tag(4, 'Long', long(1234567890123456789n)), tag(5, 'Float', float), tag(6, 'Double', double),
    tag(7, 'Bytes', Buffer.concat([int(3), Buffer.from([1, 2, 3])])), tag(8, 'String', string('Test ✓')),
    tag(9, 'List', list(10, [compound([tag(3, 'Nested', int(1))])])),
    tag(10, 'Compound', compound([tag(9, 'Empty', list(0, []))])),
    tag(11, 'Ints', Buffer.concat([int(2), int(123), int(-456)])),
    tag(12, 'Longs', Buffer.concat([int(2), long(9223372036854775807n), long(-3)])),
    tag(3, 'LevelName', int(5)), tag(4, 'LastPlayed', long(9223372036854775807n)),
    tag(9, 'lastOpenedWithVersion', list(8, [string('unknown version')])),
    tag(3, 'StorageVersion', int(-1)),
  ]));
  const { world } = await fixture(t, bytes), result = await inspectBedrockWorld(world);
  for (const key of ['name', 'lastPlayed', 'lastOpenedVersion', 'storageVersion']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(result.levelDatFormatVersion, 10);
});

test('Java gzip, missing metadata, invalid headers and trailing NBT bytes are rejected', async t => {
  const { world } = await fixture(t);
  const mismatch = level(); mismatch.writeUInt32LE(99, 4);
  const cases = [
    [Buffer.from([0x1f, 0x8b, 0, 0]), /thế giới Java/],
    [Buffer.from('not a world'), /header Bedrock/], [level(root([]), 0), /Header/], [mismatch, /kích thước/],
    [level(Buffer.concat([Buffer.from([3]), string(''), int(1)])), /Compound/],
    [level(Buffer.concat([root([]), Buffer.from([0])])), /dữ liệu thừa/],
  ];
  for (const [bytes, expected] of cases) {
    await fs.writeFile(path.join(world, 'level.dat'), bytes);
    await assert.rejects(inspectBedrockWorld(world), error => error.status === 400 && expected.test(error.message));
  }
  await fs.rm(path.join(world, 'level.dat'));
  await assert.rejects(inspectBedrockWorld(world), /thiếu level.dat/);
});

test('malformed NBT lengths, unknown types, invalid UTF-8 and duplicate names fail closed', async t => {
  const { world } = await fixture(t);
  const malformed = [
    root([tag(7, 'Bytes', int(-1))]), root([tag(11, 'Ints', int(-1))]), root([tag(12, 'Longs', int(-1))]),
    root([tag(11, 'Truncated', Buffer.concat([int(3), int(1)]))]),
    root([tag(9, 'Negative', Buffer.concat([Buffer.from([3]), int(-1)]))]),
    root([tag(9, 'EndList', Buffer.concat([Buffer.from([0]), int(1)]))]),
    root([tag(9, 'UnknownEmpty', Buffer.concat([Buffer.from([13]), int(0)]))]),
    root([tag(13, 'Unknown', Buffer.from([0]))]),
    root([tag(8, 'Utf8', Buffer.from([2, 0, 0xc0, 0xaf]))]),
    root([tag(8, 'TruncatedString', Buffer.from([5, 0, 65]))]),
    root([tag(3, 'Duplicate', int(1)), tag(3, 'Duplicate', int(2))]),
    Buffer.from([10, 0, 0, 3, 2, 0, 65]),
  ];
  for (const body of malformed) {
    await fs.writeFile(path.join(world, 'level.dat'), level(body));
    await assert.rejects(inspectBedrockWorld(world), error => error.status === 400 && /NBT/.test(error.message));
  }
});

test('NBT nesting, tag count and metadata file size have enforced resource bounds', async t => {
  const { world } = await fixture(t);
  let nested = tag(1, 'leaf', Buffer.from([1]));
  for (let depth = 0; depth < BEDROCK_WORLD_LIMITS.nbtDepth; depth++) nested = tag(10, 'child', compound([nested]));
  await fs.writeFile(path.join(world, 'level.dat'), level(root([nested])));
  await assert.rejects(inspectBedrockWorld(world), /giới hạn độ sâu/);
  const many = Array.from({ length: BEDROCK_WORLD_LIMITS.nbtTags }, (_, index) => tag(1, `f${index}`, Buffer.from([0])));
  await fs.writeFile(path.join(world, 'level.dat'), level(root(many)));
  await assert.rejects(inspectBedrockWorld(world), /số lượng thẻ/);
  await fs.writeFile(path.join(world, 'level.dat'), level(root([tag(9, 'TooMany', Buffer.concat([Buffer.from([3]), int(BEDROCK_WORLD_LIMITS.nbtTags + 1)]))])));
  await assert.rejects(inspectBedrockWorld(world), /số lượng thẻ/);
  await fs.truncate(path.join(world, 'level.dat'), BEDROCK_WORLD_LIMITS.levelBytes + 1);
  await assert.rejects(inspectBedrockWorld(world), /16 MiB/);
});

test('CURRENT can reference only one bounded ASCII MANIFEST filename inside db', async t => {
  const { world } = await fixture(t), current = path.join(world, 'db', 'CURRENT');
  for (const value of ['../MANIFEST-000001\n', '/MANIFEST-000001\n', 'MANIFEST-000001/escape\n', 'MANIFEST-000001\nMANIFEST-000002\n', 'MANIFEST-000001\n\n', ' MANIFEST-000001\n', 'MANIFEST-000001\0', 'MANIFEST-０００００１\n']) {
    await fs.writeFile(current, value);
    await assert.rejects(inspectBedrockWorld(world), error => error.status === 400 && /CURRENT/.test(error.message));
  }
  await fs.writeFile(current, 'x'.repeat(129)); await assert.rejects(inspectBedrockWorld(world), /vượt giới hạn kích thước/);
  for (const ending of ['', '\n', '\r\n']) { await fs.writeFile(current, `MANIFEST-000001${ending}`); assert.equal((await inspectBedrockWorld(world)).fileCount, 4); }
});

test('the LevelDB layout requires CURRENT, its nonempty MANIFEST and nonempty data records', async t => {
  const { world } = await fixture(t), database = path.join(world, 'db');
  await fs.rm(path.join(database, 'CURRENT')); await assert.rejects(inspectBedrockWorld(world), /thiếu tệp db\/CURRENT/);
  await fs.writeFile(path.join(database, 'CURRENT'), 'MANIFEST-000003\n'); await assert.rejects(inspectBedrockWorld(world), /MANIFEST được CURRENT/);
  await fs.writeFile(path.join(database, 'MANIFEST-000003'), ''); await assert.rejects(inspectBedrockWorld(world), /MANIFEST.*rỗng/);
  await fs.writeFile(path.join(database, 'MANIFEST-000003'), 'synthetic');
  await fs.rm(path.join(database, '000002.ldb')); await assert.rejects(inspectBedrockWorld(world), /không có tệp dữ liệu/);
  await fs.writeFile(path.join(database, '000002.log'), ''); await assert.rejects(inspectBedrockWorld(world), /không có tệp dữ liệu/);
  await fs.writeFile(path.join(database, '000002.log'), 'synthetic log'); assert.equal((await inspectBedrockWorld(world)).validation, 'bedrock-metadata-and-leveldb-layout');
  await fs.mkdir(path.join(database, 'nested')); await assert.rejects(inspectBedrockWorld(world), /Database Bedrock chứa thư mục/);
  await fs.rm(database, { recursive: true }); await assert.rejects(inspectBedrockWorld(world), /thiếu thư mục db/);
});

test('symlink roots, database folders and nested world entries are rejected on Windows and Linux', async t => {
  const { directory, world } = await fixture(t), outside = path.join(directory, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'must-not-read'), 'outside data');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  const linkedRoot = path.join(directory, 'linked-world');
  await fs.symlink(world, linkedRoot, kind); await assert.rejects(inspectBedrockWorld(linkedRoot), /liên kết tượng trưng/);
  const nestedLink = path.join(world, 'linked-assets');
  await fs.symlink(outside, nestedLink, kind); await assert.rejects(inspectBedrockWorld(world), /liên kết tượng trưng/); await fs.rm(nestedLink);
  await fs.rm(path.join(world, 'db'), { recursive: true }); await fs.symlink(outside, path.join(world, 'db'), kind);
  await assert.rejects(inspectBedrockWorld(world), /liên kết tượng trưng/);
  assert.equal(await fs.readFile(path.join(outside, 'must-not-read'), 'utf8'), 'outside data');
});

test('world tree depth is bounded and metadata/database paths must be regular files', async t => {
  const { world } = await fixture(t);
  await fs.rm(path.join(world, 'level.dat')); await fs.mkdir(path.join(world, 'level.dat'));
  await assert.rejects(inspectBedrockWorld(world), /thư mục sai vị trí/);
  await fs.rm(path.join(world, 'level.dat'), { recursive: true }); await fs.writeFile(path.join(world, 'level.dat'), level());
  await fs.rm(path.join(world, 'db', 'CURRENT')); await fs.mkdir(path.join(world, 'db', 'CURRENT'));
  await assert.rejects(inspectBedrockWorld(world), /thư mục sai vị trí/);
  await fs.rm(path.join(world, 'db', 'CURRENT'), { recursive: true }); await fs.writeFile(path.join(world, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  let directory = world;
  for (let depth = 0; depth <= BEDROCK_WORLD_LIMITS.treeDepth; depth++) { directory = path.join(directory, 'd'); await fs.mkdir(directory); }
  await assert.rejects(inspectBedrockWorld(world), /Cây thư mục thế giới vượt giới hạn/);
});

test('a real metadata size change between inspection and open has a retryable error code', async t => {
  const { world } = await fixture(t), metadata = path.join(world, 'level.dat');
  const originalOpen = fs.open.bind(fs), originalSize = (await fs.stat(metadata)).size;
  let mutated = false;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === metadata && !mutated) { mutated = true; await fs.truncate(metadata, originalSize + 1); }
    return originalOpen(filename, ...args);
  });
  await assert.rejects(inspectBedrockWorld(world), error => error.status === 409 && error.code === 'WORLD_METADATA_CHANGED');
  assert.equal(mutated, true);
});

test('bounded reads detect a real metadata file growing during the read and close its handle', async t => {
  const { world } = await fixture(t), metadata = path.join(world, 'level.dat');
  const originalOpen = fs.open.bind(fs), originalSize = (await fs.stat(metadata)).size;
  let mutated = false, closed = false;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (filename === metadata) {
      const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
      t.mock.method(handle, 'read', async (...parameters) => {
        const result = await originalRead(...parameters);
        if (!mutated) { mutated = true; await fs.truncate(metadata, originalSize + 1); }
        return result;
      });
      t.mock.method(handle, 'close', async (...parameters) => { closed = true; return originalClose(...parameters); });
    }
    return handle;
  });
  await assert.rejects(inspectBedrockWorld(world), error => error.status === 409 && error.code === 'WORLD_METADATA_CHANGED');
  assert.equal(mutated, true); assert.equal(closed, true);
});
