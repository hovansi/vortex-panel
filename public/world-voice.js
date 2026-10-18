// This module composes one Bedrock console announcement. It never schedules
// or performs the operation announced, and does not read the panel UI locale.
// Sources: Microsoft Learn /commands/commands/tellraw, /say and
// /reference/content/rawmessagejson (Minecraft Bedrock stable).
export const WORLD_VOICE_LIMITS = Object.freeze({ command: 1024, message: 800, name: 80, note: 120, custom: 320, seconds: 86400 });

const pairs = (en, vi) => Object.freeze({ en, vi });
const choice = (value, en, vi) => Object.freeze({ value, label: pairs(en, vi) });
const textField = (key, en, vi, extra = {}) => Object.freeze({ key, type: 'text', label: pairs(en, vi), defaultValue: '', maxLength: WORLD_VOICE_LIMITS.name, ...extra });
const phaseField = Object.freeze({ key: 'phase', type: 'select', label: pairs('Announcement stage', 'Giai đoạn thông báo'), defaultValue: 'planned', options: Object.freeze([choice('planned', 'Planned — operation has not completed', 'Dự kiến — thao tác chưa hoàn tất'), choice('complete', 'Complete — confirm the successful result first', 'Hoàn tất — xác nhận kết quả thành công trước')]) });

export const WORLD_VOICE_COPY = Object.freeze({
  title: pairs('World voice', 'Giọng nói thế giới'),
  effect: pairs('This sends an announcement only. Run the operation separately in the panel.', 'Chỉ gửi thông báo. Thực hiện thao tác riêng trong panel.'),
  textPolicy: pairs('Pasted line breaks, control characters and § formatting codes are removed; the template supplies the colors. Use tellraw for text containing @ selectors.', 'Dòng mới, ký tự điều khiển và mã màu § khi dán sẽ được loại bỏ; mẫu cung cấp màu chữ. Dùng tellraw cho nội dung chứa selector @.'),
  preview: pairs('In-game preview', 'Xem trước trong game'),
  literalMethod: pairs('World voice · tellraw (literal text)', 'Giọng thế giới · tellraw (văn bản nguyên nghĩa)'),
  sayMethod: pairs('Classic announcement · say (adds the server prefix)', 'Thông báo cổ điển · say (thêm tiền tố server)')
});

export const WORLD_VOICE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'welcome', label: pairs('Welcome', 'Chào mừng'), description: pairs('A warm invitation to explore and build.', 'Lời chào để người chơi khám phá và xây dựng.'), fields: Object.freeze([textField('worldName', 'World name', 'Tên thế giới', { required: true }), textField('playerName', 'Player name (optional)', 'Tên người chơi (không bắt buộc)')]) }),
  Object.freeze({ id: 'restart', label: pairs('Restart', 'Khởi động lại'), description: pairs('State the countdown and explain when to reconnect.', 'Nêu thời gian còn lại và cách kết nối lại.'), fields: Object.freeze([Object.freeze({ key: 'seconds', type: 'number', label: pairs('Seconds until restart', 'Số giây trước khi khởi động lại'), required: true, defaultValue: 60, min: 1, max: WORLD_VOICE_LIMITS.seconds, step: 1 }), textField('address', 'Rejoin address (optional)', 'Địa chỉ kết nối lại (không bắt buộc)', { maxLength: 96 })]) }),
  Object.freeze({ id: 'backup', label: pairs('Backup', 'Sao lưu'), description: pairs('Announce an upcoming backup or a confirmed successful backup.', 'Thông báo sắp sao lưu hoặc xác nhận sao lưu đã thành công.'), fields: Object.freeze([phaseField]) }),
  Object.freeze({ id: 'restore', label: pairs('Restore', 'Khôi phục'), description: pairs('Explain that progress after the selected backup will be replaced.', 'Nêu rõ tiến trình sau bản sao lưu được chọn sẽ bị thay thế.'), fields: Object.freeze([phaseField, textField('backupName', 'Backup name (optional)', 'Tên bản sao lưu (không bắt buộc)')]) }),
  Object.freeze({ id: 'maintenance', label: pairs('Maintenance', 'Bảo trì'), description: pairs('Explain an interruption or announce that maintenance has finished.', 'Thông báo gián đoạn hoặc xác nhận bảo trì đã kết thúc.'), fields: Object.freeze([phaseField, textField('note', 'Details or expected return (optional)', 'Chi tiết hoặc thời điểm dự kiến trở lại (không bắt buộc)', { maxLength: WORLD_VOICE_LIMITS.note })]) }),
  Object.freeze({ id: 'custom', label: pairs('Custom message', 'Thông điệp riêng'), description: pairs('Write your own world voice with a readable color theme.', 'Viết lời của thế giới với màu chữ dễ đọc.'), fields: Object.freeze([Object.freeze({ key: 'tone', type: 'select', label: pairs('Color theme', 'Màu thông điệp'), defaultValue: 'calm', options: Object.freeze([choice('calm', 'Aqua · calm', 'Xanh ngọc · bình yên'), choice('adventure', 'Green · adventure', 'Xanh lá · khám phá'), choice('notice', 'Gold · notice', 'Vàng · lưu ý')]) }), textField('message', 'Message', 'Thông điệp', { type: 'textarea', required: true, maxLength: WORLD_VOICE_LIMITS.custom })]) })
]);

const colors = Object.freeze({ '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA', '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF' });
export const WORLD_VOICE_FORMATTING = Object.freeze({ colors, effects: Object.freeze(['l', 'o', 'r']), userCodes: 'strip', obfuscated: false });

export class WorldVoiceValidationError extends Error {
  constructor(code, field = '', limit = undefined) {
    super(`World voice: ${code}${field ? ` (${field})` : ''}`);
    this.name = 'WorldVoiceValidationError';
    this.code = code;
    this.field = field;
    if (limit !== undefined) this.limit = limit;
  }
}

export function normalizeWorldVoiceLanguage(language) {
  return typeof language === 'string' && /^vi(?:-|$)/i.test(language.trim()) ? 'vi' : 'en';
}

export function getWorldVoiceTemplate(templateId) {
  const template = WORLD_VOICE_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new WorldVoiceValidationError('template');
  return template;
}

// User text cannot introduce another console line or take over template style.
// @, quotes, HTML-looking text, paths and names remain literal in tellraw JSON.
export function sanitizeWorldVoiceText(value, { field = '', maxLength = WORLD_VOICE_LIMITS.custom, required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new WorldVoiceValidationError('text', field);
  const source = String(value ?? '');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source)) throw new WorldVoiceValidationError('unicode', field);
  const text = source.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/§[0-9a-z]/gi, '').replaceAll('§', '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/gu, ' ').trim();
  if (required && !text) throw new WorldVoiceValidationError('required', field);
  if (text.length > maxLength) throw new WorldVoiceValidationError('length', field, maxLength);
  return text;
}

// Segments deliberately contain plain text and fixed CSS colors, never HTML.
// Use textContent (or the application's existing escaping helper) to render.
export function parseWorldVoicePreview(message) {
  const text = String(message ?? '');
  const segments = [];
  let state = { color: colors.f, bold: false, italic: false }, buffer = '';
  const flush = () => { if (buffer) { segments.push({ text: buffer, ...state }); buffer = ''; } };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '§') { buffer += char; continue; }
    flush();
    const code = text[++index]?.toLowerCase();
    if (Object.hasOwn(colors, code)) state = { ...state, color: colors[code] };
    else if (code === 'l') state = { ...state, bold: true };
    else if (code === 'o') state = { ...state, italic: true };
    else if (code === 'r') state = { color: colors.f, bold: false, italic: false };
    // Obfuscation, unsupported effects and unknown codes have no preview effect.
  }
  flush();
  return segments;
}

function normalizeValues(template, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new WorldVoiceValidationError('values');
  const normalized = {}, changedFields = [];
  for (const field of template.fields) {
    const value = values[field.key] ?? field.defaultValue;
    if (field.type === 'select') {
      if (!field.options.some(option => option.value === value)) throw new WorldVoiceValidationError('choice', field.key);
      normalized[field.key] = value;
    } else if (field.type === 'number') {
      // Do not accept scientific notation, fractions or silently coerce blanks.
      if (!(typeof value === 'number' && Number.isInteger(value) || typeof value === 'string' && /^\d+$/.test(value))) throw new WorldVoiceValidationError('seconds', field.key, field.max);
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds < field.min || seconds > field.max) throw new WorldVoiceValidationError('seconds', field.key, field.max);
      normalized[field.key] = seconds;
    } else {
      normalized[field.key] = sanitizeWorldVoiceText(value, { field: field.key, required: field.required, maxLength: field.maxLength });
      if (typeof value === 'string' && normalized[field.key] !== value) changedFields.push(field.key);
    }
  }
  return { normalized, changedFields };
}

function compose(templateId, value, language) {
  const vi = language === 'vi';
  let body;
  if (templateId === 'welcome') {
    const greeting = value.playerName ? vi ? `§fChào §a${value.playerName}§f. ` : `§fWelcome, §a${value.playerName}§f. ` : vi ? '§fChào người lữ hành. ' : '§fWelcome, traveler. ';
    body = (vi ? '§dMột chương mới mở ra. ' : '§dA new chapter opens. ') + greeting + (vi ? `§7Những chân trời mới đang chờ trong §b${value.worldName}§7. Hãy khám phá, xây dựng và để lại dấu ấn của bạn.` : `§7New horizons await in §b${value.worldName}§7. Explore, build, and leave your mark.`);
  } else if (templateId === 'restart') {
    body = vi ? `§6Thế giới sắp nghỉ một nhịp. §eKhởi động lại sau §f${value.seconds} giây§e. §7Bạn sẽ bị ngắt kết nối; ` : `§6The world takes a breath. §eRestart in §f${value.seconds} seconds§e. §7You will be disconnected; `;
    body += value.address ? vi ? `vào lại §b${value.address}§7 khi server đã online.` : `rejoin §b${value.address}§7 once the server is online.` : vi ? 'vào lại từ danh sách server khi server đã online.' : 'rejoin from your server list once the server is online.';
  } else if (templateId === 'backup') {
    body = value.phase === 'complete'
      ? vi ? '§dMột ký ức của thế giới đã được giữ lại. §aSao lưu đã hoàn tất. §7Hãy tiếp tục xây dựng; câu chuyện vẫn còn dài.' : '§dA memory of the world has been kept. §aThe backup is complete. §7Keep building; the story continues.'
      : vi ? '§dThế giới chuẩn bị giữ lại một ký ức. §bSắp sao lưu; §7bạn vẫn có thể tiếp tục chơi.' : '§dThe world is preparing a memory. §bA backup is planned; §7you can keep playing.';
  } else if (templateId === 'restore') {
    const name = value.backupName ? vi ? ` §7Bản sao: §f${value.backupName}§7.` : ` §7Snapshot: §f${value.backupName}§7.` : '';
    body = value.phase === 'complete'
      ? vi ? '§dMột chương cũ đã trở về. §aKhôi phục đã hoàn tất; §fthế giới hiện tại là bản sao được chọn.' : '§dAn earlier chapter has returned. §aRestore is complete; §fthe current world is the selected snapshot.'
      : vi ? '§dThế giới sắp lật lại một trang. §fSắp khôi phục bản sao lưu. §eTiến trình sau bản sao đó sẽ bị thay thế; server sẽ dừng. §7Vào lại khi server đã online.' : '§dThe world is turning a page. §fA backup restore is planned. §eProgress after that backup will be replaced; the server will stop. §7Rejoin when the server is online.';
    body += name;
  } else if (templateId === 'maintenance') {
    body = value.phase === 'complete'
      ? vi ? '§2Cánh cửa của thế giới lại mở. §aBảo trì đã kết thúc; bạn có thể tiếp tục cuộc hành trình.' : '§2The gates of the world are open again. §aMaintenance has finished; your journey can continue.'
      : vi ? '§6Thế giới sắp khép cổng trong chốc lát. §eSắp bảo trì. §7Bạn có thể bị ngắt kết nối; vào lại khi server đã online.' : '§6The world closes its gates for a moment. §eMaintenance is planned. §7You may be disconnected; rejoin when the server is online.';
    if (value.note) body += ` §7${value.note}`;
  } else {
    const color = { calm: 'b', adventure: 'a', notice: 'e' }[value.tone];
    body = `§${color}${value.message}`;
  }
  // say already supplies its native [Server] prefix. Never duplicate it with
  // [Vortex] or [World]; tellraw uses this same deliberately unbranded body.
  return `§b✦ §r${body}§r`;
}

/** EN is the default. Pass the persisted server message language explicitly. */
export function buildWorldVoice({ templateId = 'welcome', values = {}, language = 'en', method = 'say' } = {}) {
  const template = getWorldVoiceTemplate(templateId), selectedLanguage = normalizeWorldVoiceLanguage(language);
  if (!['tellraw', 'say'].includes(method)) throw new WorldVoiceValidationError('method');
  const { normalized, changedFields } = normalizeValues(template, values);
  const message = compose(template.id, normalized, selectedLanguage);
  if (message.length > WORLD_VOICE_LIMITS.message) throw new WorldVoiceValidationError('messageLength', '', WORLD_VOICE_LIMITS.message);
  // say's message argument expands selectors. Refuse ambiguous tokens instead
  // of silently rewriting opaque names or email addresses; tellraw is literal.
  if (method === 'say' && /@[a-z](?=$|[\s\[\],.!?;:§])/i.test(message)) throw new WorldVoiceValidationError('saySelector');
  const command = method === 'tellraw' ? `tellraw @a ${JSON.stringify({ rawtext: [{ text: message }] })}` : `say ${message}`;
  if (command.length > WORLD_VOICE_LIMITS.command) throw new WorldVoiceValidationError('commandLength', '', WORLD_VOICE_LIMITS.command);
  const segments = parseWorldVoicePreview(message);
  return { templateId: template.id, language: selectedLanguage, method, message, command, segments, plainText: segments.map(segment => segment.text).join(''), normalizedValues: normalized, changedFields };
}

export function worldVoiceErrorText(error, language = 'en') {
  const vi = normalizeWorldVoiceLanguage(language) === 'vi';
  const field = WORLD_VOICE_TEMPLATES.flatMap(template => template.fields).find(item => item.key === error?.field)?.label[vi ? 'vi' : 'en'];
  const label = field || (vi ? 'Nội dung' : 'Text');
  const messages = {
    template: pairs('Choose a valid announcement template.', 'Chọn một mẫu thông báo hợp lệ.'),
    values: pairs('Announcement fields must be an object.', 'Các trường thông báo phải là một đối tượng.'),
    method: pairs('Choose tellraw or say as the delivery method.', 'Chọn phương thức gửi tellraw hoặc say.'),
    text: pairs(`${label} must be text.`, `${label} phải là văn bản.`),
    unicode: pairs(`${label} contains an incomplete Unicode character. Paste valid text again.`, `${label} chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.`),
    required: pairs(`${label} is required.`, `Vui lòng nhập ${label.toLowerCase()}.`),
    length: pairs(`${label} must be at most ${error?.limit} characters.`, `${label} không được vượt quá ${error?.limit} ký tự.`),
    choice: pairs(`Choose a valid value for ${label.toLowerCase()}.`, `Chọn một giá trị hợp lệ cho ${label.toLowerCase()}.`),
    seconds: pairs(`Enter a whole number of seconds from 1 to ${WORLD_VOICE_LIMITS.seconds}.`, `Nhập số giây nguyên từ 1 đến ${WORLD_VOICE_LIMITS.seconds}.`),
    messageLength: pairs(`The formatted message must be at most ${WORLD_VOICE_LIMITS.message} characters.`, `Thông điệp đã định dạng không được vượt quá ${WORLD_VOICE_LIMITS.message} ký tự.`),
    commandLength: pairs(`The generated command must be at most ${WORLD_VOICE_LIMITS.command} characters.`, `Lệnh được tạo không được vượt quá ${WORLD_VOICE_LIMITS.command} ký tự.`),
    saySelector: pairs('Classic say may expand @ selectors. Use tellraw to keep this message literal.', 'Lệnh say có thể mở rộng selector @. Dùng tellraw để giữ nguyên nội dung.')
  };
  return messages[error?.code]?.[vi ? 'vi' : 'en'] || (vi ? 'Thông điệp không hợp lệ.' : 'The announcement is invalid.');
}
