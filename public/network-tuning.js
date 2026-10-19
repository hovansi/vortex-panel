import { serviceText as text, serviceEscape as escape, serviceDialogContext } from './service-ui.js';
import { withButtonBusy } from './button-busy.js';
import { uiText, formatUI } from './i18n.js';
import { formatPanelDate } from './timezone.js';

const labels = {
  'net.core.rmem_max': ['Receive socket ceiling', 'Trần bộ đệm nhận'],
  'net.core.wmem_max': ['Send socket ceiling', 'Trần bộ đệm gửi'],
  'net.ipv4.tcp_congestion_control': ['TCP congestion control', 'Điều khiển tắc nghẽn TCP'],
  'net.core.default_qdisc': ['Default queue discipline', 'Cơ chế hàng đợi mặc định'],
};
const reasons = {
  'administrator-override': ['Administrator configuration preserved', 'Giữ cấu hình quản trị viên'],
  'kernel-unavailable': ['Not exposed by this kernel', 'Kernel không cung cấp'],
  'sufficient-or-custom': ['Existing sufficient/custom ceiling preserved', 'Giữ trần bộ đệm đủ lớn/tùy chỉnh'],
  'bbr-unavailable': ['BBR is not advertised by this kernel', 'Kernel chưa cung cấp BBR'],
  'already-bbr-or-custom': ['Current BBR/custom algorithm preserved', 'Giữ BBR/thuật toán tùy chỉnh hiện tại'],
  'existing-queue-preserved': ['Existing queue preserved', 'Giữ hàng đợi hiện tại'],
};
const label = key => labels[key] ? text(...labels[key]) : key;
const reason = key => reasons[key] ? text(...reasons[key]) : text('Not changed', 'Không thay đổi');
function value(key, current) {
  if (current == null) return text('Unavailable', 'Không khả dụng');
  if (key.endsWith('mem_max') && /^\d+$/.test(String(current))) return `${Number(current) / 1048576} MiB`;
  return String(current);
}
function payload(result) {
  const data = result?.network || result;
  if (!data || typeof data !== 'object' || !data.current || !Array.isArray(data.changes) || !Array.isArray(data.skipped) || !Array.isArray(data.blockers)) throw Error(text('The network profile response could not be verified.', 'Chưa xác minh được phản hồi cấu hình mạng.'));
  return data;
}
export function networkTuningMarkup(network) {
  const rows = Object.keys(labels).map(key => {
    const change = network.changes.find(row => row.key === key), skip = network.skipped.find(row => row.key === key);
    return `<tr><th scope="row">${escape(label(key))}</th><td><code>${escape(value(key, network.current[key]))}</code></td><td>${change ? `<code>${escape(value(key, change.after))}</code>` : `<span class="muted">${escape(reason(skip?.reason))}</span>`}</td></tr>`;
  }).join('');
  const notice = network.reasonI18n ? text(network.reasonI18n.en, network.reasonI18n.vi) : network.blockers.length ? text('Review the existing profile before applying changes.', 'Kiểm tra cấu hình hiện tại trước khi áp dụng thay đổi.') : '';
  const observed = network.observedAt && Number.isFinite(new Date(network.observedAt).getTime()) ? formatUI(network.observedAt, (locale, instant) => formatPanelDate(instant, locale, { dateStyle: 'medium', timeStyle: 'medium' })) : '';
  return `<section class="network-profile" data-network-profile><p class="panel-description">${escape(text('A conservative, reversible host profile: larger socket buffer ceilings where needed and BBR for supported TCP connections. Existing larger buffers and administrator settings are preserved.', 'Cấu hình host thận trọng, có thể khôi phục: tăng trần bộ đệm khi cần và dùng BBR cho kết nối TCP được hỗ trợ. Giữ nguyên bộ đệm lớn hơn và thiết lập quản trị viên.'))}</p><div class="network-profile-table"><table><thead><tr><th>${escape(text('Setting', 'Thiết lập'))}</th><th>${escape(text('Actual value', 'Giá trị thực tế'))}</th><th>${escape(text('Proposed change', 'Thay đổi đề xuất'))}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="notice">${escape(text('Bedrock uses UDP. TCP BBR cannot reduce the physical round-trip distance between the US and Vietnam. This profile does not claim a measured latency improvement; server location, routing and congestion still determine latency.', 'Bedrock dùng UDP. BBR cho TCP không thể giảm khoảng cách truyền khứ hồi giữa Mỹ và Việt Nam. Cấu hình này không tuyên bố mức giảm độ trễ đo được; vị trí server, định tuyến và tắc nghẽn vẫn quyết định độ trễ.'))}</p><p class="panel-description">${escape(text('Routes, MTU, IPv6, firewall rules, active interface queues and default buffer allocations are preserved. Default queue changes apply to newly created queues only.', 'Giữ nguyên định tuyến, MTU, IPv6, tường lửa, hàng đợi interface đang chạy và dung lượng bộ đệm mặc định. Thay đổi hàng đợi mặc định chỉ áp dụng khi tạo hàng đợi mới.'))}</p>${notice ? `<p class="notice warn" role="status">${escape(notice)}</p>` : ''}<div class="actions"><button type="button" class="btn intent-neutral" data-intent="neutral" data-network-refresh>${escape(text('Refresh actual state', 'Tải lại trạng thái thực tế'))}</button>${network.available && !network.busy && network.changes.length ? `<button type="button" class="btn primary intent-primary" data-intent="primary" data-network-change="apply">${escape(text('Review changes', 'Xem thay đổi'))}</button>` : ''}${network.canRestore && !network.busy ? `<button type="button" class="btn intent-neutral" data-intent="neutral" data-network-change="restore">${escape(text('Restore owned settings', 'Khôi phục thiết lập đã quản lý'))}</button>` : ''}</div>${observed ? `<small class="muted">${escape(text('Observed', 'Thời điểm đo'))}: ${escape(observed)}</small>` : ''}</section>`;
}

export async function openNetworkTuning(context, { endpoint = '/host/network', name = 'VPS' } = {}) {
  if (!context.isAdmin()) throw Error(text('Administrator access is required.', 'Cần quyền quản trị viên.'));
  if (!/^\/(?:host|nodes)\/[a-zA-Z0-9_/%.-]+$/.test(endpoint) || endpoint.includes('..')) throw Error('Invalid network profile endpoint.');
  const network = payload(await context.api(endpoint));
  if (context.isCurrent && !context.isCurrent()) return;
  const opened = await context.openModal(text('Host network profile', 'Cấu hình mạng VPS'), name, networkTuningMarkup(network), null, '', true);
  if (opened === false) return;
  const root = document.querySelector('[data-network-profile]');
  if (!root) return;
  const current = serviceDialogContext(context, root, { selector: '[data-network-profile]' });
  let acting = false;
  root.addEventListener('click', async event => {
    const refresh = event.target.closest('[data-network-refresh]'), change = event.target.closest('[data-network-change]');
    if ((!refresh && !change) || acting || !current.isCurrent()) return;
    event.preventDefault(); acting = true;
    try {
      if (refresh) { await withButtonBusy(refresh, () => openNetworkTuning(current, { endpoint, name })); return; }
      const action = change.dataset.networkChange;
      const restoring = action === 'restore';
      const confirmed = await context.panelConfirm({ title: restoring ? text('Restore network settings?', 'Khôi phục thiết lập mạng?') : text('Apply network profile?', 'Áp dụng cấu hình mạng?'),
        description: restoring ? text('Restore only values that still equal the values applied by Vortex. Later administrator changes are preserved. The unchanged Vortex profile will be removed.', 'Chỉ khôi phục giá trị vẫn bằng giá trị Vortex đã áp dụng. Giữ nguyên các thay đổi quản trị viên về sau. Xóa cấu hình Vortex nếu chưa bị sửa.') : text('Apply the proposed values shown in the review. This does not restart the VPS or replace active network interface queues.', 'Áp dụng các giá trị đề xuất trong bảng xem trước. Không khởi động lại VPS hoặc thay hàng đợi interface đang chạy.'),
        confirm: restoring ? text('Restore', 'Khôi phục') : text('Apply', 'Áp dụng'), cancel: text('Keep current settings', 'Giữ thiết lập hiện tại') });
      if (!confirmed || !current.isCurrent()) return;
      await withButtonBusy(change, async () => {
        await context.api(endpoint, { method: 'POST', body: { action, revision: network.revision, confirmed: true } });
        if (current.isCurrent()) await openNetworkTuning(current, { endpoint, name });
      });
    } catch (error) {
      if (!current.isCurrent()) return;
      if (error.outcomeUnknown === true || !error.status) {
        for (const button of root.querySelectorAll('[data-network-change]')) button.disabled = true;
        let status = root.querySelector('[data-network-result]');
        if (!status) { status = document.createElement('p'); status.dataset.networkResult = ''; status.className = 'notice warn'; status.setAttribute('role', 'status'); root.append(status); }
        uiText(status, text('The outcome is not confirmed. Refresh the actual state before another change. This request was not automatically retried.', 'Chưa xác minh kết quả. Tải lại trạng thái thực tế trước khi thao tác khác. Yêu cầu không được tự gửi lại.'));
      }
      context.toast?.(error.message, true);
    }
    finally { acting = false; }
  });
}
