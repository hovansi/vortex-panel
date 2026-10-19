import { wireText } from './i18n.js';

const text = (en, vi) => wireText(vi, { en, vi });
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const base = id => `/servers/${encodeURIComponent(id)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const version = value => Array.isArray(value) ? value.join('.') : '—';
const arrow = (context, direction) => `<span class="addon-direction ${direction === 'up' ? 'is-up' : ''}" aria-hidden="true">${context.icon?.('down') || '↓'}</span>`;
const labels = {
  gametest: ['Beta APIs', 'Beta APIs', 'Allow beta Script API modules required by some behavior packs.', 'Cho phép các module Script API beta mà một số behavior pack yêu cầu.'],
  upcoming_creator_features: ['Upcoming Creator Features', 'Tính năng sáng tạo sắp tới', 'Enable upcoming creator features used by supported add-ons.', 'Bật các tính năng sáng tạo sắp tới được Add-on hỗ trợ sử dụng.'],
  data_driven_biomes: ['Custom Biomes', 'Biome tùy chỉnh', 'Allow custom biome and world-generation data from behavior packs.', 'Cho phép behavior pack cung cấp biome và dữ liệu tạo thế giới tùy chỉnh.'],
  experimental_molang_features: ['Experimental Molang Features', 'Tính năng Molang thử nghiệm', 'Enable experimental Molang queries and expressions.', 'Bật các truy vấn và biểu thức Molang thử nghiệm.'],
  experimental_creator_cameras: ['Experimental Creator Cameras', 'Camera sáng tạo thử nghiệm', 'Enable experimental custom camera features.', 'Bật các tính năng camera tùy chỉnh đang thử nghiệm.'],
  jigsaw_structures: ['Data-Driven Jigsaw Structures', 'Cấu trúc jigsaw tùy chỉnh', 'Load data-driven jigsaw structures from behavior packs.', 'Đọc cấu trúc jigsaw tùy chỉnh từ behavior pack.'],
  experimental_villager_trade: ['Villager Trade Rebalancing', 'Cân bằng trao đổi dân làng', 'Use the experimental villager trading balance.', 'Sử dụng bảng trao đổi dân làng được cân bằng thử nghiệm.'],
};

function button(context, label, action, { kind = 'soft', icon, disabled = false, attributes = '' } = {}) {
  return `<button type="button" class="btn ${kind}" data-action="${action}" ${disabled ? 'disabled' : ''} ${attributes}>${icon ? context.icon?.(icon) || '' : ''}<span>${label}</span></button>`;
}
const messages = (context, subject, key) => context.messages ? context.messages(subject, key) : subject[key] || [];
function mayRemoveLive(pack, data) {
  if (!data.runtime?.running || pack.enabled || pack.protected || !UUID.test(pack.uuid || '')) return false;
  const stacks = data.runtime.stacks, seen = new Set();
  if (!stacks || !data.runtime.capturedAt) return false;
  for (const kind of ['resource', 'behavior']) {
    if (!Array.isArray(stacks[kind]) || stacks[kind].length > 2000) return false;
    for (const entry of stacks[kind]) {
      const uuid = typeof entry?.uuid === 'string' ? entry.uuid.toLowerCase() : '';
      if (!UUID.test(uuid) || !Array.isArray(entry?.version) || entry.version.length !== 3 || entry.version.some(value => !Number.isSafeInteger(value) || value < 0) || seen.has(uuid) || uuid === pack.uuid.toLowerCase()) return false;
      seen.add(uuid);
    }
  }
  return true;
}
function packCard(pack, data, context) {
  const attrs = `data-uuid="${escape(pack.uuid || '')}" data-folder="${escape(pack.folder)}"`, errors = messages(context, pack, 'errors'), invalid = errors.length > 0;
  const togglable = context.writable && pack.uuid && (pack.enabled || data.world?.exists && !invalid);
  return `<article class="panel addon-library-card ${pack.enabled ? 'is-enabled' : ''}"><div class="addon-library-title"><span class="pack-icon ${pack.kind === 'resource' ? 'resource' : ''}">${context.icon?.(pack.kind === 'resource' ? 'layers' : 'cube') || ''}</span><div><h3>${escape(pack.name || pack.folder)}</h3><span class="pack-version">${escape(version(pack.version))} · ${pack.kind === 'resource' ? 'Resource pack' : 'Behavior pack'}</span></div><span class="badge ${pack.enabled ? '' : 'neutral'}">${pack.enabled ? text('Selected', 'Đã chọn') : text('Inactive', 'Chưa bật')}</span></div><p class="addon-description">${escape(pack.description || '')}</p><div class="addon-traits">${pack.scripting ? `<span class="badge purple">${context.icon?.('terminal') || ''}Script API</span>` : ''}${pack.requiresBetaApis ? `<span class="badge warn">${text('Requires Beta APIs', 'Cần Beta APIs')}</span>` : ''}${pack.protected ? `<span class="badge neutral">${context.icon?.('shield') || ''}${text('Bundled with Bedrock', 'Đi kèm Bedrock')}</span>` : ''}</div>${invalid ? `<details class="addon-issues"><summary>${context.icon?.('shield') || ''}${text('Review compatibility', 'Kiểm tra tương thích')} · ${errors.length}</summary><ul>${errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul></details>` : ''}<div class="addon-card-actions">${context.canManage ? button(context, pack.enabled ? text('Deactivate', 'Tắt pack') : text('Activate', 'Bật pack'), 'toggle-pack', { disabled: !togglable, icon: pack.enabled ? 'stop' : 'check', attributes: attrs, kind: pack.enabled ? 'text' : 'soft' }) : ''}${button(context, 'Manifest', 'pack-details', { kind: 'text', icon: 'file', attributes: attrs })}${context.canManage && !pack.protected ? button(context, text('Remove', 'Xóa'), 'remove-pack', { kind: 'text danger', disabled: !pack.uuid || !context.writable && !mayRemoveLive(pack, data), icon: 'trash', attributes: attrs }) : ''}</div></article>`;
}
function stackPanel(kind, data, context) {
  const entries = data.stacks?.[kind] || [], name = kind === 'resource' ? 'Resource packs' : 'Behavior packs';
  const usable = entries.every(entry => UUID.test(entry.uuid || '')) && new Set(entries.map(entry => entry.uuid?.toLowerCase())).size === entries.length;
  return `<section class="panel addon-stack" data-pack-stack="${kind}"><div class="panel-header"><div><h2>${name} <span>${entries.length}</span></h2></div><span class="pack-icon ${kind === 'resource' ? 'resource' : ''}">${context.icon?.(kind === 'resource' ? 'layers' : 'cube') || ''}</span></div><div class="addon-stack-direction">${arrow(context, 'up')}<span>${text('Highest priority at the top', 'Ưu tiên cao nhất ở trên cùng')}</span></div>${entries.length ? `<ol class="addon-stack-list">${entries.map((entry, index) => `<li class="addon-stack-row ${entry.missing ? 'is-missing' : ''}"><span class="addon-priority">${index + 1}</span><div class="addon-stack-info"><strong>${escape(entry.name || entry.uuid || text('Invalid registration', 'Đăng ký không hợp lệ'))}</strong><small>${escape(version(entry.version))}${entry.missing ? ` · ${text('Pack missing from library', 'Không tìm thấy pack trong thư viện')}` : ''}</small></div><div class="addon-stack-controls">${['up', 'down'].map(direction => `<button type="button" class="icon-button" data-action="pack-priority" data-kind="${kind}" data-uuid="${escape(entry.uuid || '')}" data-direction="${direction}" aria-label="${escape(direction === 'up' ? text('Increase priority', 'Tăng ưu tiên') : text('Decrease priority', 'Giảm ưu tiên'))} · ${escape(entry.name || entry.uuid)}" ${!context.canManage || !context.writable || !usable || direction === 'up' && !index || direction === 'down' && index === entries.length - 1 ? 'disabled' : ''}>${arrow(context, direction)}</button>`).join('')}</div></li>`).join('')}</ol>` : `<div class="addon-stack-empty">${context.icon?.(kind === 'resource' ? 'layers' : 'cube') || ''}<strong>${text('No packs in this stack', 'Chưa có pack trong danh sách này')}</strong><p>${text('Activate a pack from the library below.', 'Bật pack từ thư viện bên dưới để sử dụng.')}</p></div>`}</section>`;
}

export function addonsWorkspaceMarkup(data, context) {
  const packs = data.packs || [], custom = packs.filter(pack => !pack.protected), bundled = packs.filter(pack => pack.protected), active = (data.stacks?.behavior?.length || 0) + (data.stacks?.resource?.length || 0), warnings = messages(context, data, 'warnings');
  const runtime = data.runtime || {}, running = Boolean(runtime.running), snapshot = Boolean((runtime.capturedAt || runtime.startedAt) && Array.isArray(runtime.stacks?.resource) && Array.isArray(runtime.stacks?.behavior));
  const worldMismatch = running && runtime.worldName && runtime.worldName !== data.world?.name;
  const runningWorldNotice = worldMismatch ? `<div class="notice warn addon-running-worlds"><strong>${text('Running world', 'Thế giới đang chạy')}: ${escape(runtime.worldName)}</strong><p>${text('Showing packs for', 'Đang xem Add-on của')}: <strong>${escape(data.world?.name || '')}</strong></p></div>` : '';
  const pendingNotice = running && snapshot && runtime.configuredMatchesStartup === false && !worldMismatch ? `<div class="notice warn">${text('Add-on changes take effect after restarting the server.', 'Thay đổi Add-on sẽ có hiệu lực sau khi khởi động lại máy chủ.')}</div>` : '';
  return `<div class="addons-workspace">
    <section class="panel addons-hero"><div class="addons-hero-copy"><h2>${text('Add-ons', 'Add-on')}</h2><div class="addon-world-line">${context.icon?.('cube') || ''}<strong>${escape(data.world?.name || '')}</strong>${running && !snapshot ? `<span class="badge neutral">${text('Saved configuration', 'Cấu hình đã lưu')}</span>` : ''}</div></div><div class="addons-hero-tools">${button(context, text('Experiments', 'Tính năng thử nghiệm'), 'world-experiments', { icon: 'spark', disabled: !data.world?.exists })}${button(context, text('Refresh', 'Tải lại'), 'refresh-packs', { icon: 'refresh', kind: 'text' })}${context.canManage ? button(context, text('Import Add-on', 'Nhập Add-on'), 'import-pack', { icon: 'plus', kind: 'primary', disabled: context.canImport === false }) : ''}</div><div class="addons-summary"><div><strong>${active}</strong><span>${text('Selected packs', 'Pack đã chọn')}</span></div><div><strong>${custom.length}</strong><span>${text('Library', 'Thư viện')}</span></div><div><strong>${custom.filter(pack => pack.scripting).length}</strong><span>Script API</span></div></div></section>
    ${runningWorldNotice}${pendingNotice}
    ${!data.world?.exists ? `<div class="notice">${text('Start the server to create a world before selecting Add-ons.', 'Khởi động máy chủ để tạo thế giới trước khi chọn Add-on.')}</div>` : ''}
    ${warnings.length ? `<div class="notice warn">${warnings.map(value => escape(value)).join('<br>')}</div>` : ''}
    <div class="addon-stack-grid">${stackPanel('resource', data, context)}${stackPanel('behavior', data, context)}</div>
    ${running && snapshot && runtime.configuredMatchesStartup === false ? `<details class="panel addon-startup-snapshot"><summary>${text('Packs at startup', 'Add-on khi khởi động')}</summary><div class="addon-startup-columns">${['resource', 'behavior'].map(kind => `<div><strong>${kind === 'resource' ? 'Resource packs' : 'Behavior packs'}</strong><ol>${(runtime.stacks?.[kind] || []).map(entry => `<li>${escape(entry.name || entry.uuid)} <small>${escape(version(entry.version))}</small></li>`).join('')}</ol></div>`).join('')}</div></details>` : ''}
    <div class="section-heading"><h2>${text('Add-on library', 'Thư viện Add-on')} <span>${custom.length}</span></h2></div>
    ${custom.length ? `<div class="addon-library-grid">${custom.map(pack => packCard(pack, data, context)).join('')}</div>` : `<section class="panel addon-library-empty">${context.icon?.('layers') || ''}<h3>${text('No Add-ons yet', 'Chưa có Add-on')}</h3><p>${text('Import a .mcpack or .mcaddon file to get started.', 'Nhập tệp .mcpack hoặc .mcaddon để bắt đầu.')}</p>${context.canManage ? button(context, text('Import Add-on', 'Nhập Add-on'), 'import-pack', { icon: 'upload', disabled: context.canImport === false }) : ''}</section>`}
    ${bundled.length ? `<details id="builtin-packs" class="panel addon-bundled" ${context.builtinsOpen ? 'open' : ''}><summary>${context.icon?.('shield') || ''}<span><strong>${text('Bundled with Bedrock', 'Đi kèm Bedrock')}</strong><small>${bundled.length} ${text('packs', 'pack')}</small></span>${context.icon?.('down') || ''}</summary><div class="addon-library-grid">${bundled.map(pack => packCard(pack, data, context)).join('')}</div></details>` : ''}
  </div>`;
}

export function packOrderChange(data, kind, uuid, direction) {
  const entries = data?.stacks?.[kind];
  if (!['behavior', 'resource'].includes(kind) || !Array.isArray(entries) || !['up', 'down'].includes(direction) || !/^[a-f0-9]{64}$/.test(data.revision || '')) throw Error(text('Reload the Add-on stack before reordering.', 'Tải lại danh sách Add-on trước khi sắp xếp.'));
  const ids = entries.map(entry => entry.uuid), index = ids.findIndex(id => String(id).toLowerCase() === String(uuid).toLowerCase()), target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= ids.length || ids.some(id => !UUID.test(id || '')) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) throw Error(text('The selected priority move is no longer available.', 'Không thể đổi ưu tiên theo lựa chọn này nữa.'));
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return { revision: data.revision, packIds: ids };
}

export function experimentsEditorMarkup(data, { canManage = true } = {}) {
  return `<section class="experiments-editor"><div class="notice warn"><strong>${text('Protect your world before experimenting.', 'Bảo vệ thế giới trước khi thử nghiệm.')}</strong><p>${text('Experiments may permanently change compatibility or break add-ons after a game update. Turning a toggle off does not erase experimental history. Vortex creates a verified backup before saving a change.', 'Thử nghiệm có thể thay đổi vĩnh viễn tính tương thích hoặc làm Add-on lỗi sau khi cập nhật game. Tắt lại không xóa lịch sử thử nghiệm. Vortex tạo bản sao lưu đã xác minh trước khi lưu thay đổi.')}</p></div>${data.running ? `<div class="notice">${text('Current saved settings are visible while running. Stop Bedrock to edit level.dat safely.', 'Có thể xem thiết lập đã lưu khi server chạy. Dừng Bedrock để sửa level.dat an toàn.')}</div>` : ''}<div class="experiment-list">${(data.experiments || []).map(item => {
    const label = labels[item.id], title = label ? text(label[0], label[1]) : item.name || item.id, description = label ? text(label[2], label[3]) : text('A native flag preserved without changes.', 'Cờ của thế giới được giữ nguyên, không thay đổi.');
    return `<label class="experiment-option ${!item.available ? 'is-unavailable' : ''}"><span><strong>${escape(title)}</strong><small>${escape(description)}</small><code>${escape(item.id)}</code>${!item.available ? `<small class="experiment-availability">${item.recognized ? text('Not exposed by this world or installed runtime', 'World hoặc runtime đã cài chưa có cờ này') : text('Unrecognized native flag · preserved', 'Cờ chưa được nhận diện · được giữ nguyên')}</small>` : ''}</span><input type="checkbox" name="experiment:${escape(item.id)}" ${item.enabled === true ? 'checked' : ''} ${!canManage || !item.editable ? 'disabled' : ''} role="switch" aria-label="${escape(title)}"></label>`;
  }).join('')}</div>${!data.experiments?.length ? `<div class="notice">${text('The world has not been generated yet. Start it once, then reopen experiments.', 'Thế giới chưa được tạo. Khởi động một lần rồi mở lại thử nghiệm.')}</div>` : ''}<label class="check-row experiment-ack"><input type="checkbox" name="acknowledgeExperimental" ${data.running || !canManage ? 'disabled' : ''}><span>${text('I understand experimental history can remain permanent, and a backup will be created before saving.', 'Tôi hiểu lịch sử thử nghiệm có thể tồn tại vĩnh viễn và bản sao lưu sẽ được tạo trước khi lưu.')}</span></label></section>`;
}

export async function openWorldExperiments(serverId, context) {
  const server = context.findServer?.(serverId), data = await context.api(`${base(serverId)}/experiments`);
  if (context.isCurrent && !context.isCurrent()) return;
  const canManage = context.canManage ? context.canManage(server) : true, editable = canManage && !data.running && data.world?.exists && data.experiments?.some(item => item.editable);
  const opened = await context.openModal(text('World experiments', 'Tính năng thử nghiệm'), data.world?.name || server?.name || '', experimentsEditorMarkup(data, { canManage }), editable ? async (values, form) => {
    const flags = {};
    for (const item of data.experiments || []) if (item.editable) { const checked = form.elements.namedItem(`experiment:${item.id}`)?.checked === true; if (checked !== item.enabled) flags[item.id] = checked; }
    if (!Object.keys(flags).length) { context.toast?.(text('No experiments changed.', 'Chưa thay đổi thử nghiệm nào.')); return; }
    const acknowledgeExperimental = form.elements.namedItem('acknowledgeExperimental')?.checked === true;
    if (Object.values(flags).some(Boolean) && !acknowledgeExperimental) throw Error(text('Confirm the experimental world warning before enabling a feature.', 'Xác nhận cảnh báo thử nghiệm trước khi bật tính năng.'));
    let result = await context.api(`${base(serverId)}/experiments`, { method: 'PATCH', body: { revision: data.revision, flags, acknowledgeExperimental } });
    if (result?.job) {
      form.dataset.committed = 'true'; form.dataset.dirty = 'false';
      if (context.showJobDetails && result.job.id) { await context.showJobDetails(result.job.id); return false; }
      if (!context.waitForJob) throw Error(text('The experiment operation was accepted. Check its job result before submitting again.', 'Tác vụ thử nghiệm đã được nhận. Kiểm tra kết quả tác vụ trước khi gửi lại.'));
      result = await context.waitForJob(result.job, server);
      if (result?.status !== 'completed' && result?.job?.status !== 'completed' && !result?.backup?.id) throw Error(text('Experiment completion could not be verified. Check the task result.', 'Chưa xác minh được hoàn tất thử nghiệm. Kiểm tra kết quả tác vụ.'));
    } else if (result?.changed !== false && (!result?.backup?.id || !/^[a-f0-9]{64}$/.test(result?.revision || ''))) throw Error(text('Experiment completion could not be verified. Reload the settings before retrying.', 'Chưa xác minh được hoàn tất thử nghiệm. Tải lại thiết lập trước khi thử tiếp.'));
    context.toast?.(text('Experiments saved with a backup. They apply at the next world start.', 'Đã lưu thử nghiệm và sao lưu. Thay đổi có hiệu lực ở lần khởi động world kế tiếp.'));
    await context.refresh?.();
  } : null, editable ? text('Back up & save', 'Sao lưu và lưu') : '', !editable);
  const form = opened === false ? null : typeof document !== 'undefined' ? document.querySelector('#modal-form') : opened?.form || opened;
  if (form?.querySelector && editable) {
    const acknowledgement = form.elements.namedItem('acknowledgeExperimental');
    form.querySelectorAll('[name^="experiment:"]').forEach(input => input.addEventListener('change', () => {
      if (acknowledgement && input.checked) acknowledgement.closest('label')?.classList.add('needs-attention');
    }));
  }
  return opened;
}
