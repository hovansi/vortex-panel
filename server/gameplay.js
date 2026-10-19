import { randomUUID } from 'node:crypto';
import { fail } from './safety.js';
import { trackBedrockPlayer } from './bedrock-log.js';
import { GAMEPLAY_MESSAGES } from './gameplay-messages.js';

const pair = (en, vi) => Object.freeze({ en, vi });
const booleanRule = (key, group, en, vi, descriptionEn, descriptionVi, featured = false) => Object.freeze({ key, group, label: pair(en, vi), description: pair(descriptionEn, descriptionVi), type: 'boolean', requiresCheats: false, ...(featured ? { featured: true } : {}) });
// Stable console names/types: https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/gamerule?view=minecraft-bedrock-stable
// Semantics: https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/gamerules?view=minecraft-bedrock-stable
// Never initialize values from documentation defaults: only native queries
// establish a world's actual value. Unsupported old engines report rejection.
export const GAME_RULES = Object.freeze([
  booleanRule('showcoordinates', 'display', 'Show coordinates', 'Hiện tọa độ', 'Show each player’s X, Y and Z on their screen.', 'Hiện vị trí X, Y, Z trên màn hình của từng người chơi.', true),
  booleanRule('showdaysplayed', 'display', 'Show days played', 'Hiện số ngày đã chơi', 'Display the world’s day counter for players.', 'Hiện bộ đếm ngày của thế giới cho người chơi.'),
  booleanRule('showdeathmessages', 'display', 'Death messages', 'Thông báo khi chết', 'Announce player deaths in chat.', 'Thông báo người chơi chết trong khung chat.'),
  booleanRule('showtags', 'display', 'Item restriction tags', 'Nhãn giới hạn vật phẩm', 'Display item hints such as Can Place On and Can Destroy.', 'Hiện gợi ý vật phẩm như Có thể đặt lên và Có thể phá.'),
  booleanRule('showrecipemessages', 'display', 'Recipe notifications', 'Thông báo công thức', 'Notify players when they unlock recipes.', 'Thông báo cho người chơi khi mở khóa công thức.'),
  booleanRule('keepinventory', 'survival', 'Keep inventory after death', 'Giữ đồ khi chết', 'Retain inventory and experience when a player dies.', 'Giữ vật phẩm và kinh nghiệm khi người chơi chết.', true),
  booleanRule('doimmediaterespawn', 'survival', 'Immediate respawn', 'Hồi sinh ngay', 'Skip the death screen and respawn immediately.', 'Bỏ qua màn hình chết và hồi sinh ngay.'),
  booleanRule('pvp', 'survival', 'Player versus player combat', 'Người chơi đánh nhau', 'Allow players to damage other players.', 'Cho phép người chơi gây sát thương cho nhau.'),
  booleanRule('naturalregeneration', 'survival', 'Natural health regeneration', 'Tự hồi máu', 'Allow natural health recovery through normal survival conditions.', 'Cho phép tự hồi máu khi đáp ứng điều kiện sinh tồn.'),
  booleanRule('drowningdamage', 'survival', 'Drowning damage', 'Sát thương đuối nước', 'Apply damage when an entity runs out of air underwater.', 'Gây sát thương khi thực thể hết không khí dưới nước.'),
  booleanRule('falldamage', 'survival', 'Fall damage', 'Sát thương khi rơi', 'Apply damage from falling.', 'Gây sát thương khi rơi từ trên cao.'),
  booleanRule('firedamage', 'survival', 'Fire damage', 'Sát thương lửa', 'Apply damage from fire and lava.', 'Gây sát thương từ lửa và dung nham.'),
  booleanRule('freezedamage', 'survival', 'Freezing damage', 'Sát thương đóng băng', 'Apply freezing damage, including in powder snow.', 'Gây sát thương đóng băng, gồm khi ở trong tuyết bột.'),
  booleanRule('doinsomnia', 'survival', 'Phantoms from insomnia', 'Phantom do thiếu ngủ', 'Allow the effects of going without sleep, including phantom spawning.', 'Cho phép hậu quả của việc thiếu ngủ, gồm sinh phantom.'),
  booleanRule('dodaylightcycle', 'environment', 'Day and night cycle', 'Chu kỳ ngày đêm', 'Advance world time naturally. Turning this off keeps the current time.', 'Cho thời gian tự trôi. Tắt để giữ thời điểm hiện tại.'),
  booleanRule('doweathercycle', 'environment', 'Weather cycle', 'Chu kỳ thời tiết', 'Allow weather to change naturally. Turning this off keeps the current weather.', 'Cho thời tiết tự đổi. Tắt để giữ thời tiết hiện tại.'),
  Object.freeze({ key: 'randomtickspeed', group: 'environment', label: pair('Random tick speed', 'Tốc độ tick ngẫu nhiên'), description: pair('Controls random block updates such as crop growth. High values can overload the server.', 'Điều khiển cập nhật khối ngẫu nhiên như cây trồng. Giá trị cao có thể làm quá tải máy chủ.'), type: 'integer', min: 0, max: 4096, requiresCheats: false }),
  Object.freeze({ key: 'spawnradius', group: 'environment', label: pair('Player spawn radius', 'Bán kính sinh người chơi'), description: pair('Block radius around world spawn for player spawning; does not affect Adventure mode.', 'Bán kính tính bằng khối quanh điểm sinh thế giới; không tác động chế độ Phiêu lưu.'), type: 'integer', min: 0, max: 128, requiresCheats: false }),
  booleanRule('domobspawning', 'mobs', 'Natural mob spawning', 'Mob tự sinh', 'Allow mobs to spawn naturally; existing mobs remain.', 'Cho mob tự sinh; không xóa mob đang có.'),
  booleanRule('mobgriefing', 'mobs', 'Mob changes to blocks', 'Mob thay đổi khối', 'Allow mob interactions that alter blocks, such as creeper destruction.', 'Cho phép mob tác động lên khối, ví dụ creeper phá khối.'),
  booleanRule('doentitydrops', 'mobs', 'Entity item drops', 'Vật phẩm rơi từ thực thể', 'Allow non-mob entities to drop items when destroyed.', 'Cho thực thể không phải mob rơi vật phẩm khi bị phá.'),
  booleanRule('domobloot', 'mobs', 'Mob loot', 'Vật phẩm từ mob', 'Allow mobs to drop loot when killed.', 'Cho mob rơi vật phẩm khi chết.'),
  booleanRule('dotiledrops', 'mobs', 'Block item drops', 'Vật phẩm rơi khi phá khối', 'Allow broken blocks to drop items.', 'Cho khối bị phá rơi vật phẩm.'),
  booleanRule('dofiretick', 'building', 'Fire spreads and burns', 'Lửa lan và đốt khối', 'Allow fire to spread and consume blocks. Fire damage is a separate rule.', 'Cho lửa lan và đốt khối. Sát thương lửa là luật riêng.'),
  booleanRule('tntexplodes', 'building', 'TNT explosions', 'TNT phát nổ', 'Allow TNT to ignite and explode.', 'Cho phép kích hoạt và làm nổ TNT.'),
  booleanRule('respawnblocksexplode', 'building', 'Respawn block explosions', 'Khối hồi sinh phát nổ', 'Allow beds and respawn anchors to explode when used in an unsuitable dimension.', 'Cho giường và mỏ neo hồi sinh phát nổ khi dùng sai chiều không gian.'),
  booleanRule('projectilescanbreakblocks', 'building', 'Projectiles break blocks', 'Đạn phá khối', 'Allow supported projectiles to break vulnerable blocks, such as decorated pots.', 'Cho loại đạn phù hợp phá khối dễ vỡ như bình trang trí.'),
  booleanRule('tntexplosiondropdecay', 'building', 'TNT drop decay', 'Giảm vật phẩm sau nổ TNT', 'Allow TNT explosions to destroy some block drops instead of dropping every block.', 'Cho nổ TNT làm mất một phần vật phẩm thay vì rơi mọi khối.'),
  booleanRule('recipesunlock', 'advanced', 'Unlock recipes through play', 'Mở công thức khi chơi', 'Unlock vanilla recipes as players progress.', 'Mở công thức mặc định theo tiến trình người chơi.'),
  booleanRule('dolimitedcrafting', 'advanced', 'Require unlocked recipes', 'Chỉ chế tạo công thức đã mở', 'Limit crafting to recipes the player has unlocked.', 'Chỉ cho chế tạo theo công thức người chơi đã mở.'),
  booleanRule('commandblocksenabled', 'advanced', 'Command blocks', 'Khối lệnh', 'Allow command blocks to execute. Enabling this may activate existing world automation.', 'Cho khối lệnh chạy. Bật có thể kích hoạt hệ thống lệnh sẵn có.'),
  booleanRule('commandblockoutput', 'advanced', 'Command block chat output', 'Phản hồi chat từ khối lệnh', 'Allow command blocks to report their output in chat.', 'Cho khối lệnh gửi kết quả vào chat.'),
  booleanRule('sendcommandfeedback', 'advanced', 'Command feedback', 'Phản hồi lệnh', 'Display command feedback to players. This does not replace the panel’s native readback.', 'Hiện phản hồi lệnh cho người chơi. Panel vẫn cần đọc lại từ máy chủ.')
]);
const rules = new Map(GAME_RULES.map(rule => [rule.key, rule]));
// Curated names documented by Microsoft's Default Minecraft Item Listings.
// This is intentionally a finite catalog, not arbitrary commands/components.
export const GAME_ITEMS = Object.freeze([
  ['minecraft:apple', 'Apple', 'Táo'], ['minecraft:bread', 'Bread', 'Bánh mì'], ['minecraft:cooked_beef', 'Cooked beef', 'Thịt bò chín'],
  ['minecraft:golden_apple', 'Golden apple', 'Táo vàng'], ['minecraft:carrot', 'Carrot', 'Cà rốt'], ['minecraft:torch', 'Torch', 'Đuốc'],
  ['minecraft:stone', 'Stone', 'Đá'], ['minecraft:cobblestone', 'Cobblestone', 'Đá cuội'], ['minecraft:dirt', 'Dirt', 'Đất'],
  ['minecraft:oak_planks', 'Oak planks', 'Ván gỗ sồi'], ['minecraft:glass', 'Glass', 'Kính'], ['minecraft:diamond', 'Diamond', 'Kim cương'],
  ['minecraft:iron_ingot', 'Iron ingot', 'Thỏi sắt'], ['minecraft:gold_ingot', 'Gold ingot', 'Thỏi vàng'], ['minecraft:emerald', 'Emerald', 'Ngọc lục bảo'],
  ['minecraft:diamond_sword', 'Diamond sword', 'Kiếm kim cương'], ['minecraft:diamond_pickaxe', 'Diamond pickaxe', 'Cuốc kim cương'],
  ['minecraft:bow', 'Bow', 'Cung'], ['minecraft:arrow', 'Arrow', 'Mũi tên'], ['minecraft:shield', 'Shield', 'Khiên']
].map(([id, en, vi]) => Object.freeze({ id, label: pair(en, vi), maxCount: 64 })));
const field = (key, type, en, vi, extra = {}) => Object.freeze({ key, type, label: pair(en, vi), ...extra, ...(Object.hasOwn(extra, 'defaultValue') ? { default: extra.defaultValue } : {}) });
const action = (id, en, vi, requiresCheats, destructive, fields = []) => Object.freeze({ id, label: pair(en, vi), description: pair('Targets only this still-connected player. Native feedback is separate from client receipt.', 'Chỉ tác động người chơi vẫn trong phiên kết nối đã chọn. Phản hồi native khác với xác nhận từ client.'), requiresCheats, destructive, fields });
export const PLAYER_ACTIONS = Object.freeze([
  action('give', 'Give item', 'Cho vật phẩm', true, false, [field('itemId', 'item', 'Item', 'Vật phẩm', { required: true }), field('count', 'integer', 'Quantity', 'Số lượng', { min: 1, max: 64, defaultValue: 1, required: true })]),
  action('kill', 'Kill player', 'Hạ người chơi', true, true),
  action('kick', 'Kick player', 'Mời người chơi ra', false, true, [field('reason', 'text', 'Reason (optional)', 'Lý do (không bắt buộc)', { maxLength: 160, defaultValue: '' })]),
  action('heal', 'Apply instant health', 'Hồi máu tức thời', true, false),
  action('gamemode', 'Change game mode', 'Đổi chế độ chơi', true, false, [field('mode', 'select', 'Game mode', 'Chế độ chơi', { options: ['survival', 'creative', 'adventure', 'spectator'], defaultValue: 'survival', required: true })]),
  action('teleport', 'Teleport to coordinates', 'Dịch chuyển đến tọa độ', true, true, [field('x', 'number', 'X', 'X', { min: -30000000, max: 30000000, required: true }), field('y', 'number', 'Y', 'Y', { min: -1024, max: 1024, required: true }), field('z', 'number', 'Z', 'Z', { min: -30000000, max: 30000000, required: true })]),
  action('op', 'Grant operator', 'Cấp operator', false, true), action('deop', 'Remove operator', 'Gỡ operator', false, true)
]);
const actions = new Map(PLAYER_ACTIONS.map(item => [item.id, item]));
const strictObject = (value, keys, message) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(message); };
const revision = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('Mã phiên thế giới không hợp lệ.'); return value; };
export function validateRuleValue(key, value) {
  const rule = rules.get(key); if (!rule) fail('Luật thế giới không nằm trong danh sách được hỗ trợ.');
  if (rule.type === 'boolean' ? typeof value !== 'boolean' : !Number.isInteger(value) || value < rule.min || value > rule.max) fail('Giá trị luật thế giới không đúng kiểu hoặc vượt giới hạn.');
  return value;
}
export function validateRuleQuery(input) {
  strictObject(input, ['worldRevision', 'keys'], 'Yêu cầu đọc luật thế giới không hợp lệ.'); revision(input.worldRevision);
  const keys = input.keys === undefined ? GAME_RULES.map(rule => rule.key) : input.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > GAME_RULES.length || new Set(keys).size !== keys.length || keys.some(key => !rules.has(key))) fail('Danh sách luật thế giới không hợp lệ.');
  return { worldRevision: input.worldRevision, keys: [...keys] };
}
export function validateRuleChanges(input) {
  strictObject(input, ['worldRevision', 'changes', 'expected'], 'Yêu cầu đổi luật thế giới không hợp lệ.'); revision(input.worldRevision);
  const keys = input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes) ? Object.keys(input.changes) : [];
  if (!keys.length || keys.length > GAME_RULES.length) fail('Hãy chọn ít nhất một luật thế giới hợp lệ.');
  strictObject(input.expected, keys, 'Giá trị luật thế giới dùng để đối chiếu không hợp lệ.');
  if (Object.keys(input.expected).length !== keys.length) fail('Giá trị luật thế giới dùng để đối chiếu không hợp lệ.');
  for (const key of keys) { validateRuleValue(key, input.changes[key]); validateRuleValue(key, input.expected[key]); }
  return { worldRevision: input.worldRevision, changes: { ...input.changes }, expected: { ...input.expected }, keys };
}
export function quotePlayerName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim() || name.length > 80 || /[@*\[\]"\\\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069§]/u.test(name) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)) fail('Tên người chơi không thể dùng làm một mục tiêu an toàn.');
  return `"${name}"`;
}
export function buildPlayerAction(input, language = 'en') {
  strictObject(input, ['worldRevision', 'action', 'target', 'values'], 'Yêu cầu tương tác người chơi không hợp lệ.'); revision(input.worldRevision);
  const spec = actions.get(input.action); if (!spec) fail('Tương tác người chơi không được hỗ trợ.');
  strictObject(input.target, ['name', 'xuid', 'connectionId'], 'Danh tính phiên kết nối người chơi không hợp lệ.');
  const quoted = quotePlayerName(input.target.name), { xuid, connectionId } = input.target;
  if (typeof xuid !== 'string' || !/^\d{0,20}$/.test(xuid) || xuid && BigInt(xuid) > 18446744073709551615n || typeof connectionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(connectionId)) fail('Danh tính phiên kết nối người chơi không hợp lệ.');
  const values = input.values === undefined ? {} : input.values; strictObject(values, spec.fields.map(item => item.key), 'Trường tương tác người chơi không hợp lệ.');
  let command;
  if (spec.id === 'give') {
    if (!GAME_ITEMS.some(item => item.id === values.itemId) || !Number.isInteger(values.count) || values.count < 1 || values.count > 64) fail('Chọn vật phẩm trong danh sách và số lượng từ 1–64.');
    command = `give ${quoted} ${values.itemId} ${values.count}`;
  } else if (spec.id === 'kick') {
    const reason = values.reason === undefined || values.reason === '' ? language === 'vi' ? 'Cánh cổng nghỉ một nhịp. Hãy vào lại để tiếp tục cuộc hành trình.' : 'The gate rests for a moment. Join again to continue your journey.' : values.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 160 || /[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069§]/u.test(reason) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(reason) || /@[a-z](?=$|[\s\[\],.!?;:])/i.test(reason)) fail('Lý do kick cần là một dòng từ 1–160 ký tự, không có mã định dạng hoặc selector.');
    command = `kick ${quoted} ${reason.trim()}`;
  } else if (spec.id === 'heal') command = `effect ${quoted} instant_health 1 4 true`;
  else if (spec.id === 'gamemode') { if (!spec.fields[0].options.includes(values.mode)) fail('Chế độ chơi không hợp lệ.'); command = `gamemode ${values.mode} ${quoted}`; }
  else if (spec.id === 'teleport') { for (const field of spec.fields) if (typeof values[field.key] !== 'number' || !Number.isFinite(values[field.key]) || values[field.key] < field.min || values[field.key] > field.max) fail('Tọa độ dịch chuyển không đúng kiểu hoặc vượt giới hạn.'); command = `teleport ${quoted} ${values.x} ${values.y} ${values.z} true`; }
  else command = `${spec.id} ${quoted}`;
  return { spec, command, target: { ...input.target }, values: { ...values }, worldRevision: input.worldRevision };
}

const nativeHeader = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?(?:INFO|WARN|WARNING|ERROR)\]\s*/;
const nativeInfoHeader = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?INFO\]\s*/;
export function nativeGameplayBody(line) { return typeof line === 'string' && nativeHeader.test(line) ? line.replace(nativeHeader, '') : null; }
export function trackGameplayPlayer(online, connections, line) {
  if (nativeGameplayBody(line) === null) return false;
  const previous = new Map(online);
  if (!trackBedrockPlayer(online, line)) return false;
  for (const key of connections.keys()) if (!online.has(key)) connections.delete(key);
  for (const [key, player] of online) if (!connections.has(key) || previous.get(key)?.name !== player.name || previous.get(key)?.xuid !== player.xuid) connections.set(key, randomUUID());
  return true;
}
export const connectedGameplayPlayers = (online, connections) => [...online.entries()].map(([key, player]) => ({ ...player, connectionId: connections.get(key) })).filter(player => player.connectionId);
export function assertGameplayPlayer(online, connections, target) {
  const matching = connectedGameplayPlayers(online, connections).filter(player => player.name === target.name);
  if (matching.length !== 1 || matching[0].xuid !== target.xuid || matching[0].connectionId !== target.connectionId) fail('Người chơi đã rời hoặc đổi phiên kết nối. Hãy chọn lại người chơi trực tuyến.', 409);
}
export function parseNativeRule(line, key) {
  const body = nativeGameplayBody(line), rule = rules.get(key); if (!body || !rule || !nativeInfoHeader.test(line)) return null;
  const found = body.match(/^([a-z]+) = (true|false|\d+)\.?$/i); if (!found || found[1].toLowerCase() !== key) return null;
  const value = rule.type === 'boolean' ? found[2] === 'true' ? true : found[2] === 'false' ? false : null : /^\d+$/.test(found[2]) ? Number(found[2]) : null;
  try { validateRuleValue(key, value); } catch { return null; }
  return { value, nativeFeedback: body };
}
export function parseNativeRuleResponse(line, key, { mutation = false } = {}) {
  if (!rules.has(key)) return null;
  const body = nativeGameplayBody(line); if (!body) return null;
  const value = parseNativeRule(line, key); if (value) return { status: 'confirmed', reasonCode: 'native-rule-value', ...value };
  if (/^(?:You do not have permission to (?:use|execute) this command|You don't have permission to (?:use|execute) this command|Cheats (?:are not|aren't) enabled)/i.test(body)) return { status: 'rejected', reasonCode: 'permission-denied', message: 'Bedrock từ chối quyền thực hiện lệnh luật thế giới.', nativeFeedback: body };
  if (/^(?:Syntax error:|Unknown command:|Invalid game rule|Unknown game rule|Incorrect argument for command)/i.test(body)) return { status: 'rejected', reasonCode: 'unsupported-or-invalid-rule', message: 'Tiến trình không hỗ trợ hoặc từ chối luật thế giới này.', nativeFeedback: body };
  if (mutation && nativeInfoHeader.test(line) && new RegExp(`^(?:Game rule |Gamerule )${key}\\b.*(?:updated|changed|set)`, 'i').test(body)) return { status: 'confirmed', reasonCode: 'native-rule-acknowledgement', setFeedback: true, nativeFeedback: body };
  return null;
}
// The caller must first validate a complete, bounded Bedrock level.dat with
// parseLevelDatTags and only use this snapshot while its server is stopped.
// Missing, unsupported and mistyped tags remain unknown; documentation defaults
// and a previous world's observations are never substituted.
export function savedGameRulesFromTags(tags) {
  if (!Array.isArray(tags)) throw new TypeError('Validated root NBT tags are required.');
  const result = [];
  for (const rule of GAME_RULES) {
    const matches = tags.filter(tag => tag?.name === rule.key);
    if (matches.length !== 1) continue;
    const tag = matches[0];
    if (tag.type !== (rule.type === 'boolean' ? 1 : 3)) continue;
    if (rule.type === 'boolean' && tag.value !== 0 && tag.value !== 1) continue;
    const value = rule.type === 'boolean' ? tag.value === 1 : tag.value;
    try { validateRuleValue(rule.key, value); } catch { continue; }
    result.push({ key: rule.key, value, status: 'saved', source: 'world-level.dat', readOnly: true });
  }
  return result;
}
// One coordinator belongs to one managed process. Reads can take a few seconds;
// simultaneous metadata requests must share that work rather than queueing a
// console scan per viewer. Failed/partial reads are throttled too. This helper
// never applies values and never carries observations into another world.
export function createGameRuleRefresh({ cooldownMs = 60000, clock = () => Date.now() } = {}) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 1000 || cooldownMs > 3600000 || typeof clock !== 'function') throw new TypeError('Invalid world-rule refresh policy.');
  let generation = 0, currentWorld = null, state = { status: 'idle', lastAttemptAt: null, retryAt: null }, attemptedAt = null;
  const pending = new Map(), timestamp = value => new Date(value).toISOString();
  function select(worldRevision) {
    revision(worldRevision);
    if (currentWorld !== worldRevision) { currentWorld = worldRevision; generation++; attemptedAt = null; state = { status: 'idle', lastAttemptAt: null, retryAt: null }; }
  }
  const markRead = (worldRevision, { confirmed = true } = {}) => {
    select(worldRevision); const time = clock(); attemptedAt = time;
    state = { status: confirmed ? 'current' : 'partial', lastAttemptAt: timestamp(time), retryAt: timestamp(time + cooldownMs) };
  };
  return {
    snapshot(worldRevision) { return currentWorld === worldRevision ? { ...state } : { status: 'idle', lastAttemptAt: null, retryAt: null }; },
    markRead,
    async refresh(worldRevision, operation, { force = false } = {}) {
      select(worldRevision);
      if (typeof operation !== 'function') throw new TypeError('A read operation is required.');
      if (pending.has(worldRevision)) return pending.get(worldRevision);
      const time = clock();
      if (!force && attemptedAt !== null && time - attemptedAt < cooldownMs) return { refreshed: false, throttled: true };
      const selectedGeneration = generation;
      attemptedAt = time; state = { status: 'refreshing', lastAttemptAt: timestamp(time), retryAt: timestamp(time + cooldownMs) };
      const run = Promise.resolve().then(operation).then(result => {
        if (generation === selectedGeneration) state = { ...state, status: result?.confirmed === false ? 'partial' : 'current' };
        return { refreshed: true, result };
      }, error => {
        if (generation === selectedGeneration) state = { ...state, status: 'unconfirmed' };
        return { refreshed: false, error };
      }).finally(() => { if (pending.get(worldRevision) === run) pending.delete(worldRevision); });
      pending.set(worldRevision, run); return run;
    }
  };
}
export async function applyGameRuleChanges(input, { console, guard, query, onRead = () => {} }) {
  // Read every baseline before writing the first change. This is optimistic
  // concurrency, not an atomic multi-rule transaction in the native engine.
  const baselines = new Map();
  for (const key of input.keys) {
    await guard(); const current = await query(key); await guard(); onRead(current);
    if (current.status !== 'confirmed') fail('Chưa đọc được giá trị luật thế giới hiện tại. Chưa gửi thay đổi; hãy đọc lại.', 409);
    if (current.value !== input.expected[key]) fail('Giá trị luật thế giới đã thay đổi. Bản nháp được giữ; hãy đọc lại và kiểm tra trước khi áp dụng.', 409);
    baselines.set(key, current);
  }
  const results = [];
  for (const key of input.keys) {
    let sent;
    try {
      await guard();
      // Re-reading an unchanged rule is enough. Never rewrite an already
      // persisted value just because a caller submitted it again.
      if (baselines.get(key).value === input.changes[key]) {
        const read = baselines.get(key);
        results.push({ key, requested: input.changes[key], value: read.value, status: 'confirmed', confirmedApplied: true, acceptedToConsole: false, changed: false, reasonCode: 'already-current', ...(read.nativeFeedback ? { nativeFeedback: read.nativeFeedback } : {}) });
        continue;
      }
      sent = await console.exchange(`gamerule ${key} ${input.changes[key]}`, line => parseNativeRuleResponse(line, key, { mutation: true }), { endFence: true });
      if (sent.status === 'unconfirmed' || sent.status === 'rejected') { results.push({ key, requested: input.changes[key], acceptedToConsole: Boolean(sent.acceptedToConsole), confirmedApplied: false, status: sent.status, ...(sent.reasonCode ? { reasonCode: sent.reasonCode } : {}), ...(sent.message ? { message: sent.message } : {}), ...(sent.nativeFeedback ? { nativeFeedback: sent.nativeFeedback } : {}), ...(sent.warnings?.length ? { warnings: sent.warnings } : {}) }); break; }
      await guard(); const read = await query(key); await guard(); onRead(read);
      const confirmedApplied = read.status === 'confirmed' && read.value === input.changes[key];
      results.push({ key, requested: input.changes[key], acceptedToConsole: Boolean(sent.acceptedToConsole), confirmedApplied, value: read.value, status: confirmedApplied ? 'confirmed' : 'unconfirmed', ...(!confirmedApplied ? { reasonCode: read.status === 'confirmed' ? 'readback-mismatch' : 'readback-unconfirmed' } : {}), ...(read.nativeFeedback ? { nativeFeedback: read.nativeFeedback } : {}), ...(sent.warnings?.length ? { warnings: sent.warnings } : {}), ...(!confirmedApplied ? { message: 'Lệnh đã được nhận nhưng chưa xác nhận giá trị mong muốn. Không tự gửi lại thay đổi.' } : {}) });
      if (!confirmedApplied) break;
    } catch (error) {
      if (!results.length && !sent?.acceptedToConsole) throw error;
      results.push({ key, requested: input.changes[key], acceptedToConsole: Boolean(sent?.acceptedToConsole), confirmedApplied: false, status: sent?.acceptedToConsole ? 'unconfirmed' : 'not-sent', message: error.message }); break;
    }
  }
  for (const key of input.keys) if (!results.some(result => result.key === key)) results.push({ key, requested: input.changes[key], acceptedToConsole: false, confirmedApplied: false, status: 'not-sent', message: 'Chưa gửi luật này vì thao tác trước chưa được xác nhận. Hãy đọc lại trước khi áp dụng tiếp.' });
  return { results, allConfirmed: results.every(result => result.confirmedApplied), partial: results.some(result => result.acceptedToConsole) && results.some(result => !result.confirmedApplied), atomic: false };
}
function teleportFeedbackCoordinates(request) {
  // The command builder emits numeric literals. Bedrock centers integer X/Z
  // literals on their block (+0.5), including negative blocks; Y is unchanged.
  return ['x', 'y', 'z'].map(key => {
    const value = request.values[key], centered = key !== 'y' && /^-?\d+$/.test(String(value)) ? value + 0.5 : value;
    return Number(centered.toFixed(2));
  });
}
export function parseNativePlayerResult(line, request) {
  const body = nativeGameplayBody(line); if (!body) return null;
  const rejected = reasonCode => ({ confirmedApplied: false, status: 'rejected', reasonCode, nativeFeedback: body });
  if (/^(?:No targets matched selector\.?|That player cannot be found\.?|That entity cannot be found\.?)$/.test(body)) return rejected('no-targets');
  if (/^(?:You do not have permission|Incorrect permission level|Cheats (?:are not|aren't) enabled|Commands (?:are not|aren't) enabled)/.test(body)) return rejected('permission-denied');
  if (/^(?:Syntax error:|Unknown command:|Invalid command syntax:)/.test(body)) return rejected('command-rejected');
  const name = request.target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), target = `"?${name}"?`;
  if (request.spec.id === 'teleport' && (new RegExp(`^Unable to teleport ${target} to `).test(body) || /^Cannot teleport entities outside of the world\.?$/.test(body))) return rejected('destination-rejected');
  if (/^(?:Cannot |Could not |Couldn't |Failed to |Players cannot be killed while )/.test(body)) return rejected('native-rejected');
  // Positive feedback must come from a native INFO record. ERROR text, input
  // echoes and chat can never establish a successful action.
  if (!/^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?INFO\]\s*/.test(line)) return null;
  if (request.spec.id === 'give') {
    const match = new RegExp(`^Gave (.+) \\* (\\d+) to ${target}$`).exec(body), item = GAME_ITEMS.find(row => row.id === request.values.itemId);
    // Only the existing finite catalog's English label/identifier is known.
    // Other engine/localized item labels stay unconfirmed rather than guessed.
    if (!match || Number(match[2]) !== request.values.count || !item || ![item.label.en.toLowerCase(), item.id.toLowerCase()].includes(match[1].toLowerCase())) return null;
    return { confirmedApplied: true, status: 'confirmed', reasonCode: 'native-confirmed', nativeFeedback: body };
  }
  if (request.spec.id === 'teleport') {
    const number = '(-?\\d+(?:\\.\\d+)?)', match = new RegExp(`^Teleported ${target} to ${number}, ${number}, ${number}\\.?$`).exec(body);
    if (!match || !teleportFeedbackCoordinates(request).every((value, index) => Number(match[index + 1]) === value)) return null;
    return { confirmedApplied: true, status: 'confirmed', reasonCode: 'native-confirmed', nativeFeedback: body };
  }
  const positive = {
    kill: new RegExp(`^Killed ${target}$`), kick: new RegExp(`^Kicked ${target} from the game(?:|: '.+')$`),
    heal: new RegExp(`^Gave (?:Instant Health|instant_health) \\* 4 to ${target} for (?:0|1) seconds\\.?$`, 'i'),
    gamemode: new RegExp(`^Set ${target}'s game mode to ${request.values.mode}\\.?$`, 'i'),
    op: new RegExp(`^(?:Made ${target} a server operator|Opped:? ${target})$`),
    deop: new RegExp(`^(?:(?:De-opped|Deopped):? ${target}|Made ${target} no longer a server operator|Removed operator status from ${target})$`)
  }[request.spec.id];
  // Fencing and exclusive stdin serialize feedback. Never accept plain input
  // echoes, player chat, [Server] messages or an unrelated target's success.
  if (positive?.test(body)) return { confirmedApplied: true, status: 'confirmed', reasonCode: 'native-confirmed', nativeFeedback: body };
  return null;
}

export async function executePlayerAction(input, { console }) {
  // Native feedback has no request ID. Include only values distinguished by
  // its matcher, excluding connection IDs/reasons that stdout cannot prove.
  const values = input.spec.id === 'give' ? [input.values.itemId, input.values.count] : input.spec.id === 'gamemode' ? [input.values.mode]
    : input.spec.id === 'teleport' ? teleportFeedbackCoordinates(input) : [];
  const fingerprint = JSON.stringify([input.spec.id, input.target.name.toLocaleLowerCase('en-US'), ...values]);
  const result = await console.exchange(input.command, line => parseNativePlayerResult(line, input), { endFence: true, fingerprint });
  const reasonCode = result.reasonCode || (result.status === 'confirmed' ? 'native-confirmed' : 'feedback-unconfirmed');
  const messageKey = result.status === 'confirmed' ? `player_${input.spec.id}_confirmed` : reasonCode === 'no-targets' ? 'player_no_targets'
    : reasonCode === 'prior-feedback-ambiguous' ? 'player_prior_ambiguous' : reasonCode === 'feedback-ambiguity-capacity' ? 'player_ambiguity_capacity' : result.status === 'rejected' ? 'player_rejected' : 'player_unconfirmed';
  const entry = GAMEPLAY_MESSAGES.find(row => row.id === `panel.gameplay.${messageKey}`), params = [input.target.name];
  const messageI18n = { ...entry, params, en: entry.en.replaceAll('{0}', params[0]), vi: entry.vi.replaceAll('{0}', params[0]) };
  return { action: input.spec.id, target: input.target, acceptedToConsole: Boolean(result.acceptedToConsole), confirmedApplied: result.confirmedApplied === true, status: result.status, reasonCode,
    ...(result.nativeFeedback ? { nativeFeedback: result.nativeFeedback } : {}), message: messageI18n.vi, messageI18n,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}), correlation: { method: 'native-console-fences', completed: result.boundaryConfirmed === true }, clientReceiptConfirmed: false };
}

export function createGameplayConsole({ send, timeoutMs = 2500, ambiguityLimit = 64 }) {
  if (!Number.isInteger(ambiguityLimit) || ambiguityLimit < 1 || ambiguityLimit > 256) throw new TypeError('Invalid native feedback ambiguity limit.');
  let locked = false, pending = null, closed = false; const internalTokens = new Set();
  const unresolved = new Set(); let ambiguitySaturated = false;
  const finish = value => {
    if (!pending) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    const resolve = () => {
      let result = { ...current.receipt, ...value };
      if (current.fingerprint && result.acceptedToConsole) {
        if (result.status === 'confirmed' && (ambiguitySaturated || unresolved.has(current.fingerprint))) result = { ...result, status: 'unconfirmed', confirmedApplied: false, reasonCode: ambiguitySaturated ? 'feedback-ambiguity-capacity' : 'prior-feedback-ambiguous' };
        if (result.status === 'unconfirmed' && !unresolved.has(current.fingerprint)) {
          if (unresolved.size >= ambiguityLimit) ambiguitySaturated = true;
          else unresolved.add(current.fingerprint);
        }
      }
      current.resolve(result);
    };
    if (current.receipt === null) queueMicrotask(resolve); else resolve();
  };
  const token = () => { const value = 'vortex_query_' + randomUUID().replaceAll('-', ''); internalTokens.add(value); if (internalTokens.size > 32) internalTokens.delete(internalTokens.values().next().value); return value; };
  return {
    get busy() { return locked; },
    async run(operation) { if (closed) fail('Console native đã đóng.', 409); if (locked) fail('Console đang đọc hoặc áp dụng thao tác gameplay. Hãy chờ hoàn tất.', 409); locked = true; try { return await operation(this); } finally { locked = false; } },
    consume(line) {
      const body = nativeGameplayBody(line); if (!body) return false;
      const internal = /^Unknown command: (vortex_query_[a-f0-9]+)\./.exec(body)?.[1];
      if (pending) {
        const current = pending;
        const inspect = () => {
          if (pending !== current) return;
          // Old/internal fence errors never belong to a later player action.
          if (internal) {
            if (internal === current.boundary) {
              if (current.conflict) finish({ status: 'unconfirmed', confirmedApplied: false, reasonCode: 'feedback-conflict', boundaryConfirmed: true });
              else finish({ status: 'unconfirmed', confirmedApplied: false, reasonCode: 'feedback-unconfirmed', ...current.candidate, boundaryConfirmed: true });
              return;
            }
            if (!current.internal || internal !== current.command) return;
          } else if (current.internal) return;
          let result; try { result = current.match(line); } catch { return; }
          if (!result) return;
          if (current.boundary) {
            if (current.candidate && JSON.stringify(current.candidate) !== JSON.stringify(result)) current.conflict = true;
            else current.candidate = result;
          } else finish({ status: 'confirmed', ...result });
        };
        if (current.receipt === null) queueMicrotask(inspect); else inspect();
      }
      return Boolean(internal && internalTokens.has(internal));
    },
    async fence() {
      const command = token();
      const result = await this.exchange(command, line => nativeGameplayBody(line)?.startsWith(`Unknown command: ${command}.`) ? { fenced: true } : null, { internal: true });
      if (!result.fenced) fail('Không đồng bộ được phản hồi console native. Chưa gửi thay đổi gameplay; hãy thử đọc lại.', 409);
    },
    exchange(command, match, { internal = false, endFence = false, fingerprint = null } = {}) {
      if (!locked || closed || pending) fail('Console native không sẵn sàng cho thao tác gameplay.', 409);
      return new Promise((resolve, reject) => {
        const current = { command, internal, match, resolve, fingerprint, receipt: null, timer: null, boundary: endFence ? token() : null, candidate: null, conflict: false }; pending = current;
        current.timer = setTimeout(() => finish({ status: 'unconfirmed', confirmedApplied: false, reasonCode: endFence ? 'feedback-boundary-missing' : 'feedback-unconfirmed', ...(current.candidate?.nativeFeedback ? { nativeFeedback: current.candidate.nativeFeedback } : {}), boundaryConfirmed: false, message: 'Console đã nhận lệnh nhưng chưa có phản hồi native phù hợp. Không tự gửi lại thao tác.' }), timeoutMs);
        try { current.receipt = send(command, { internal }); if (!current.receipt?.acceptedToConsole) fail('Console native không xác nhận đã nhận lệnh.', 409); }
        catch (error) { pending = null; clearTimeout(current.timer); reject(error); }
        if (pending === current && current.boundary) {
          try { if (!send(current.boundary, { internal: true })?.acceptedToConsole) throw new Error('boundary'); }
          catch { finish({ status: 'unconfirmed', confirmedApplied: false, reasonCode: 'feedback-boundary-missing', boundaryConfirmed: false }); }
        }
      });
    },
    close() { closed = true; finish({ status: 'unconfirmed', confirmedApplied: false, reasonCode: 'native-closed', boundaryConfirmed: false, message: 'Tiến trình native đã đóng trước khi xác nhận thao tác.' }); }
  };
}
