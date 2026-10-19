import { uiHTML, uiText, plainUI } from './i18n.js';
import { serviceText as text, serviceEscape as escape } from './service-ui.js';

const HEX = /^#[a-f0-9]{6}$/i, HASH = /^[a-f0-9]{64}$/;
const colors = Object.freeze({ 0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa', 8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff', g: '#ddd605', h: '#e3d4d1', i: '#cecaca', j: '#443a3b', m: '#971607', n: '#b4684d', p: '#deb12d', q: '#47a036', s: '#2cbaa8', t: '#21497b', u: '#9a5cc6' });
const base = id => `/servers/${encodeURIComponent(id)}/appearance`;
export const appearanceAccent = server => HEX.test(server?.appearance?.accent || '') ? server.appearance.accent.toLowerCase() : '#a998ff';
export const appearanceImageURL = (server, slot) => ['icon', 'cover'].includes(slot) && HASH.test(server?.appearance?.[slot]?.sha256 || '') ? `/api${base(server.id)}/media/${slot}?revision=${server.appearance[slot].sha256}` : '';
export const appearanceStyle = server => `--server-accent:${appearanceAccent(server)}`;
export function serverCoverMarkup(server, { decorative = true } = {}) {
  const url = appearanceImageURL(server, 'cover');
  return `<div class="server-brand-cover ${url ? 'has-image' : 'is-generated'}" style="${appearanceStyle(server)}" ${decorative ? 'aria-hidden="true"' : ''}>${url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async">` : '<span class="server-brand-horizon"></span><span class="server-brand-cube server-brand-cube-one"></span><span class="server-brand-cube server-brand-cube-two"></span>'}<span class="server-brand-shade"></span></div>`;
}
export function serverIconMarkup(server, { className = '' } = {}) {
  const url = appearanceImageURL(server, 'icon'), initial = String(server?.name || 'V').trim().slice(0, 1).toUpperCase();
  return `<span class="server-brand-icon ${escape(className)}" style="${appearanceStyle(server)}" aria-hidden="true">${url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async">` : `<span>${escape(initial)}</span>`}</span>`;
}
export function serverDescriptionMarkup(server) { const value = server?.appearance?.description; return typeof value === 'string' && value ? `<p class="server-brand-description">${escape(value)}</p>` : ''; }

// Literal text only: no user HTML, Java formatting, selectors or animation.
export function bedrockNameSegments(value) {
  let buffer = '', color = colors.f, bold = false, italic = false; const result = [];
  const flush = () => { if (buffer) result.push({ text: buffer, color, bold, italic }); buffer = ''; };
  const source = String(value ?? '').slice(0, 1024);
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '§') {
      const code = source[index + 1]?.toLowerCase();
      if (code && (colors[code] || ['l', 'o', 'r', 'k'].includes(code))) {
        flush(); index++;
        if (colors[code]) color = colors[code]; else if (code === 'l') bold = true; else if (code === 'o') italic = true; else if (code === 'r') { color = colors.f; bold = false; italic = false; }
        continue;
      }
    }
    buffer += source[index];
  }
  flush(); return result;
}
export const bedrockNameMarkup = value => bedrockNameSegments(value).map(item => `<span style="color:${item.color};font-weight:${item.bold ? '750' : '450'};font-style:${item.italic ? 'italic' : 'normal'}">${escape(item.text)}</span>`).join('');
function preview(server, appearance, values = {}) {
  const view = { ...server, appearance: { ...appearance, description: values.description ?? appearance.description, accent: values.accent ?? appearance.accent } };
  return `<div class="appearance-preview-card" style="${appearanceStyle(view)}">${serverCoverMarkup(view)}<div class="appearance-preview-identity">${serverIconMarkup(view)}<div><strong>${escape(server.name)}</strong><p>${escape(view.appearance.description || plainUI(text('Your next chapter starts here.', 'Chương tiếp theo bắt đầu tại đây.')))}</p></div><span class="appearance-preview-dot" aria-hidden="true"></span></div></div>`;
}
const uploadMarkup = (slot, appearance) => {
  const label = slot === 'cover' ? text('Cover image', 'Ảnh bìa') : text('Server icon', 'Biểu tượng máy chủ'), note = slot === 'cover' ? text('16:7 recommended · up to 6 MiB · 4096 px per side', 'Nên dùng tỷ lệ 16:7 · tối đa 6 MiB · mỗi cạnh 4096 px') : text('Square recommended · up to 2 MiB · 2048 px per side', 'Nên dùng ảnh vuông · tối đa 2 MiB · mỗi cạnh 2048 px');
  return `<section class="appearance-upload"><div><h4>${escape(label)}</h4><p>${escape(note)}</p></div><div class="appearance-upload-actions"><label class="btn appearance-file-button" for="appearance-${slot}"><span>${escape(text('Choose image', 'Chọn ảnh'))}</span><input id="appearance-${slot}" type="file" accept="image/png,image/jpeg,image/webp" data-appearance-upload="${slot}"></label><button type="button" class="btn intent-neutral" data-intent="neutral" data-appearance-op="remove" data-slot="${slot}" ${appearance[slot] ? '' : 'disabled'}>${escape(text('Remove', 'Bỏ ảnh'))}</button></div></section>`;
};
function listingMarkup(server, serverName) {
  const stopped = ['stopped', 'error'].includes(server.status) && !server.busy;
  return `<section class="appearance-bedrock"><div class="appearance-section-title"><span class="eyebrow">${escape(text('MINECRAFT BEDROCK', 'MINECRAFT BEDROCK'))}</span><h3>${escape(text('Server listing text', 'Nội dung danh sách máy chủ'))}</h3><p>${escape(text('This edits the real server-name property. Save it separately while the server is stopped, then start the server to apply it.', 'Mục này sửa server-name thực tế. Lưu riêng khi máy chủ đã dừng, sau đó khởi động để áp dụng.'))}</p></div><div class="field"><label for="appearance-motd">${escape(text('Server name / MOTD', 'Tên hiển thị / MOTD'))}</label><input id="appearance-motd" name="motd" value="${escape(serverName)}" maxlength="512" autocomplete="off" spellcheck="false" data-appearance-motd><small>${escape(text('Use § color codes. One line; semicolons and line breaks are not supported.', 'Dùng mã màu §. Một dòng; không hỗ trợ dấu chấm phẩy hay xuống dòng.'))}</small></div><div class="appearance-palette" role="group" aria-label="${escape(text('Insert a Minecraft text color', 'Chèn màu chữ Minecraft'))}">${Object.entries(colors).filter(([key]) => /^[0-9a-f]$/.test(key)).map(([code, color]) => `<button type="button" class="appearance-color" style="--swatch:${color}" data-appearance-op="format" data-code="${code}" aria-label="${escape(text('Insert color', 'Chèn màu'))} §${code}" title="§${code}"></button>`).join('')}<button type="button" class="appearance-format" data-appearance-op="format" data-code="l" title="${escape(text('Bold', 'In đậm'))}"><b>B</b></button><button type="button" class="appearance-format" data-appearance-op="format" data-code="o" title="${escape(text('Italic', 'In nghiêng'))}"><i>I</i></button><button type="button" class="appearance-format" data-appearance-op="format" data-code="r">${escape(text('Reset', 'Đặt lại'))}</button></div><div class="appearance-motd-preview" aria-label="${escape(text('Approximate text preview', 'Xem trước văn bản gần đúng'))}" data-appearance-motd-preview>${bedrockNameMarkup(serverName)}</div><div class="appearance-listing-footer"><button type="button" class="btn intent-primary" data-intent="primary" data-appearance-op="motd" ${stopped ? '' : 'disabled'}>${escape(text('Save server listing text', 'Lưu nội dung danh sách'))}</button><span data-appearance-motd-state>${escape(stopped ? text('Applies on the next start', 'Áp dụng ở lần khởi động tiếp theo') : text('Stop the server before saving this text', 'Dừng máy chủ trước khi lưu nội dung này'))}</span></div><p class="appearance-capability-note">${escape(text('Partner-server icons and banners in the official Minecraft list are managed by Minecraft. Panel cover images, icons and descriptions stay in Vortex; they cannot be added to an ordinary Bedrock client server entry.', 'Ảnh và biểu tượng server đối tác trong danh sách Minecraft do Minecraft quản lý. Ảnh bìa, biểu tượng và miêu tả panel được lưu trong Vortex; chúng không thể gắn vào mục máy chủ Bedrock thông thường.'))} <a href="https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/server-properties" target="_blank" rel="noopener noreferrer">${escape(text('Bedrock server properties', 'Thuộc tính máy chủ Bedrock'))} ↗</a></p></section>`;
}
export function appearanceEditorMarkup(server, appearance, { serverName = null } = {}) {
  return `<section class="appearance-editor" data-appearance-editor><div data-appearance-preview>${preview(server, appearance)}</div><div class="appearance-section-title"><span class="eyebrow">${escape(text('YOUR SERVER, YOUR IDENTITY', 'MÁY CHỦ CỦA BẠN, DẤU ẤN CỦA BẠN'))}</span><h3>${escape(text('Panel appearance', 'Giao diện trong panel'))}</h3><p>${escape(text('Personalize server cards and the workspace. Images are stored privately with this server on its VPS.', 'Tùy chỉnh thẻ máy chủ và workspace. Ảnh được lưu riêng cùng máy chủ trên VPS của nó.'))}</p></div><div class="appearance-form-grid"><div class="field"><label for="appearance-description">${escape(text('Description', 'Miêu tả'))}</label><input id="appearance-description" name="description" value="${escape(appearance.description || '')}" maxlength="320" placeholder="${escape(text('Survival · Friends · A world worth building', 'Sinh tồn · Bạn bè · Một thế giới đáng xây dựng'))}" data-appearance-description><small data-appearance-description-count>${String(appearance.description || '').length} / 320</small></div><div class="field appearance-accent-field"><label for="appearance-accent">${escape(text('Accent color', 'Màu chủ đạo'))}</label><div class="appearance-accent-control"><input id="appearance-accent" name="accent" type="color" value="${HEX.test(appearance.accent) ? appearance.accent : '#a998ff'}" data-appearance-accent><span data-appearance-accent-value>${escape(appearance.accent)}</span></div></div></div><div class="appearance-uploads">${uploadMarkup('cover', appearance)}${uploadMarkup('icon', appearance)}</div><p class="appearance-image-policy">${escape(text('PNG, JPEG or WebP only. No remote image links or animated files. Upload and remove actions save immediately; description and accent use Save appearance.', 'Chỉ PNG, JPEG hoặc WebP. Không nhận liên kết ảnh bên ngoài hay ảnh động. Tải và bỏ ảnh được lưu ngay; miêu tả và màu dùng nút Lưu giao diện.'))}</p><p class="appearance-feedback" role="status" aria-live="polite" data-appearance-feedback></p>${serverName !== null ? listingMarkup(server, serverName) : ''}</section>`;
}

export async function openServerAppearance(serverId, context) {
  const server = context.findServer(serverId); if (!server || !context.canManage(server)) throw Error(text('You cannot change this server appearance.', 'Bạn không có quyền đổi giao diện máy chủ này.'));
  const response = await context.api(base(serverId));
  if (!response?.appearance || !HASH.test(response.appearance.revision || '')) throw Error(text('Appearance could not be verified. Reload and try again.', 'Không xác minh được giao diện. Tải lại và thử lại.'));
  let appearance = response.appearance, serverName = null;
  if (!['nodejs', 'python'].includes(server.kind)) { const properties = await context.api(`/servers/${encodeURIComponent(serverId)}/properties`); serverName = String(properties?.properties?.['server-name'] ?? server.name); }
  if (context.isCurrent && !context.isCurrent()) return;
  let form, busy = false, savedName = serverName, closed = false;
  const opened = await context.openModal(text('Server appearance', 'Giao diện máy chủ'), server.name, appearanceEditorMarkup(server, appearance, { serverName }), async values => {
    if (busy) throw Error(text('Wait for the image operation to finish.', 'Đợi thao tác ảnh hoàn tất.'));
    assertCurrent();
    const result = await context.api(base(serverId), { method: 'PATCH', body: { revision: appearance.revision, description: values.description, accent: values.accent } });
    if (!validResponse(result)) throw Error(text('The save result is unconfirmed. Reload appearance before saving again.', 'Chưa xác minh được kết quả lưu. Mở lại giao diện trước khi lưu tiếp.'));
    appearance = result.appearance;
    context.toast?.(text('Server appearance saved.', 'Đã lưu giao diện máy chủ.'));
    try { await context.refresh?.(); } catch { context.toast?.(text('Appearance was saved, but the workspace could not refresh. Reload it to see the latest card.', 'Đã lưu giao diện nhưng chưa tải lại được workspace. Tải lại trang để thấy thẻ mới nhất.'), true); }
    if (values.motd !== undefined && values.motd !== savedName) { feedback(text('Panel appearance saved. Your listing text is still unsaved; save it separately before closing.', 'Đã lưu giao diện panel. Nội dung danh sách vẫn chưa lưu; hãy lưu riêng trước khi đóng.')); return false; }
    return true;
  }, text('Save appearance', 'Lưu giao diện'), true);
  if (opened === false) return;
  form = document.querySelector('#modal-form'); if (!form) return;
  const editor = form.querySelector('[data-appearance-editor]'), modal = form.closest('dialog'), actor = context.actorId?.();
  const current = () => !closed && form.isConnected && modal?.open && document.querySelector('#modal-form') === form && context.actorId?.() === actor;
  function assertCurrent() { const target = context.findServer(serverId); if (!current() || !target || !context.canManage(target)) throw Error(text('This appearance session is no longer active.', 'Phiên chỉnh giao diện này không còn hiệu lực.')); }
  function validResponse(result) { return result?.appearance && HASH.test(result.appearance.revision || ''); }
  function feedback(value, error = false) { if (!current()) return; const element = editor.querySelector('[data-appearance-feedback]'); element.classList.toggle('is-error', error); uiText(element, value); }
  function notifyChanged(result) { try { Promise.resolve(context.onChanged?.(result)).catch(() => {}); } catch {} }
  function repaint() {
    if (!current()) return;
    const description = form.elements.description.value, accent = form.elements.accent.value;
    uiHTML(editor.querySelector('[data-appearance-preview]'), preview(server, appearance, { description, accent }));
    uiText(editor.querySelector('[data-appearance-description-count]'), `${description.length} / 320`);
    uiText(editor.querySelector('[data-appearance-accent-value]'), accent.toUpperCase());
    for (const button of editor.querySelectorAll('[data-appearance-op="remove"]')) button.disabled = busy || !appearance[button.dataset.slot];
    const motd = editor.querySelector('[data-appearance-motd]'); if (motd) uiHTML(editor.querySelector('[data-appearance-motd-preview]'), bedrockNameMarkup(motd.value));
  }
  async function validateBrowserImage(file, slot) {
    if (typeof createImageBitmap !== 'function') return;
    let bitmap;
    try { bitmap = await createImageBitmap(file); const max = slot === 'icon' ? 2048 : 4096; if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > max || bitmap.height > max) throw Error(text(`Use an image up to ${max} pixels per side.`, `Dùng ảnh có mỗi cạnh tối đa ${max} pixel.`)); }
    catch (error) { throw Error(error.message?.includes('pixel') ? error.message : text('This image could not be decoded. Choose another PNG, JPEG or WebP.', 'Không đọc được ảnh này. Chọn ảnh PNG, JPEG hoặc WebP khác.')); }
    finally { bitmap?.close(); }
  }
  function pending(value) {
    busy = value; editor.classList.toggle('is-busy', value); editor.setAttribute('aria-busy', String(value));
    for (const element of editor.querySelectorAll('button,input[type="file"]')) element.disabled = value || element.dataset.appearanceOp === 'remove' && !appearance[element.dataset.slot] || element.dataset.appearanceOp === 'motd' && (!['stopped', 'error'].includes(context.findServer(serverId)?.status) || context.findServer(serverId)?.busy);
    const submit = form.querySelector('button[type="submit"]'); if (submit) submit.disabled = value;
  }
  const onClose = () => { if (modal.open && form.isConnected) return; closed = true; modal.removeEventListener('close', onClose); for (const input of form.querySelectorAll('input[type="file"]')) input.value = ''; };
  modal.addEventListener('close', onClose);
  editor.addEventListener('input', repaint);
  editor.addEventListener('change', async event => {
    const input = event.target.closest('[data-appearance-upload]'); if (!input || busy) return;
    const file = input.files?.[0]; if (!file) return;
    try {
      assertCurrent(); const limit = input.dataset.appearanceUpload === 'icon' ? 2 : 6;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > limit * 1024 ** 2) throw Error(text(`Choose a PNG, JPEG or WebP image up to ${limit} MiB.`, `Chọn ảnh PNG, JPEG hoặc WebP không quá ${limit} MiB.`));
      pending(true); feedback(text('Uploading and checking image…', 'Đang tải và kiểm tra ảnh…'));
      await validateBrowserImage(file, input.dataset.appearanceUpload); assertCurrent();
      const body = new FormData(); body.append('revision', appearance.revision); body.append('file', file);
      const result = await context.api(`${base(serverId)}/media/${input.dataset.appearanceUpload}`, { method: 'POST', body });
      if (!current()) return; if (!validResponse(result)) throw Error(text('The upload result is unconfirmed. Reopen appearance to check it.', 'Chưa xác minh được kết quả tải ảnh. Mở lại giao diện để kiểm tra.'));
      appearance = result.appearance; feedback(result.warnings?.join(' ') || text('Image saved.', 'Đã lưu ảnh.')); repaint(); notifyChanged(result);
    } catch (error) { feedback(error.message, true); }
    finally { input.value = ''; if (current()) pending(false); }
  });
  editor.addEventListener('click', async event => {
    const button = event.target.closest('[data-appearance-op]'); if (!button || busy) return; event.preventDefault();
    try {
      assertCurrent();
      if (button.dataset.appearanceOp === 'format') {
        const input = editor.querySelector('[data-appearance-motd]'), start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
        input.setRangeText(`§${button.dataset.code}`, start, start, 'end'); if (end > start) input.setSelectionRange(start + 2, end + 2); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); return;
      }
      pending(true);
      if (button.dataset.appearanceOp === 'remove') {
        feedback(text('Removing image…', 'Đang bỏ ảnh…'));
        const result = await context.api(`${base(serverId)}/media/${button.dataset.slot}`, { method: 'DELETE', body: { revision: appearance.revision } });
        if (!current()) return; if (!validResponse(result)) throw Error(text('The removal result is unconfirmed. Reopen appearance to check it.', 'Chưa xác minh được kết quả bỏ ảnh. Mở lại giao diện để kiểm tra.'));
        appearance = result.appearance; feedback(result.warnings?.join(' ') || text('Image removed.', 'Đã bỏ ảnh.')); repaint(); notifyChanged(result);
      } else if (button.dataset.appearanceOp === 'motd') {
        const target = context.findServer(serverId), input = editor.querySelector('[data-appearance-motd]'), value = input.value;
        if (!['stopped', 'error'].includes(target.status) || target.busy) throw Error(text('Stop the server before saving its listing text.', 'Dừng máy chủ trước khi lưu nội dung danh sách.'));
        if (!value.trim() || value.length > 512 || /[;\u0000-\u001f\u007f-\u009f]/u.test(value)) throw Error(text('Use one non-empty line without semicolons, up to 512 characters.', 'Dùng một dòng không rỗng, không có dấu chấm phẩy, tối đa 512 ký tự.'));
        const fresh = await context.api(`/servers/${encodeURIComponent(serverId)}/properties`);
        if (!current()) return; if (String(fresh?.properties?.['server-name'] ?? '') !== savedName) throw Error(text('Server listing text changed. Reopen appearance before saving.', 'Nội dung danh sách đã thay đổi. Mở lại giao diện trước khi lưu.'));
        feedback(text('Saving Bedrock server-name…', 'Đang lưu server-name Bedrock…'));
        const result = await context.api(`/servers/${encodeURIComponent(serverId)}/configuration`, { method: 'PATCH', body: { properties: { 'server-name': value } } });
        if (!current()) return; if (result?.properties?.['server-name'] !== value) throw Error(text('The listing save result is unconfirmed. Reload server properties before retrying.', 'Chưa xác minh được kết quả lưu nội dung. Tải lại thuộc tính máy chủ trước khi thử lại.'));
        savedName = value; uiText(editor.querySelector('[data-appearance-motd-state]'), text('Saved · applies on the next start', 'Đã lưu · áp dụng ở lần khởi động tiếp theo')); feedback(text('Bedrock listing text saved. Panel artwork is unchanged.', 'Đã lưu nội dung danh sách Bedrock. Ảnh trong panel giữ nguyên.'));
      }
    } catch (error) { feedback(error.message, true); }
    finally { if (current()) pending(false); }
  });
}
