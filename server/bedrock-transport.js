// RakNet is deprecated from the 1.26.60 engine line. Apply the same
// conservative boundary to stable packages when that line reaches stable.
export function requiresNetherNet(version) {
  const [major, minor, patch] = String(version).split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 26 || (minor === 26 && patch >= 60)));
}

export function allowedBedrockTransports({ version, packageTransport }) {
  if (requiresNetherNet(version)) return ['nethernet'];
  return packageTransport === 'nethernet' ? ['raknet', 'nethernet'] : ['raknet'];
}

export function selectBedrockTransport({ version, packageTransport, savedTransport }) {
  const allowed = allowedBedrockTransports({ version, packageTransport });
  if (allowed.includes(savedTransport)) return savedTransport;
  return allowed.includes('raknet') ? 'raknet' : 'nethernet';
}

// A node advertises this policy only after its manager enforces it for every
// new Bedrock create and clone. Legacy instances retain their saved transport.
export const BEDROCK_TRANSPORT_POLICY = Object.freeze({ schemaVersion: 1, creation: 'nethernet' });
export const BEDROCK_TRANSPORT_MESSAGES = Object.freeze([
  Object.freeze({ id: 'panel.bedrock.transport.nethernet-required', en: 'Vortex uses NetherNet for Minecraft Bedrock. Choose a compatible package and keep NetherNet selected; the installed engine and world were not changed.', vi: 'Vortex sử dụng NetherNet cho Minecraft Bedrock. Chọn gói cài tương thích và giữ giao thức NetherNet; phiên bản đã cài và thế giới được giữ nguyên.' }),
  Object.freeze({ id: 'panel.bedrock.transport.node-required', en: 'Update this VPS agent before creating or cloning Bedrock servers. Its NetherNet creation policy could not be verified.', vi: 'Cập nhật agent VPS này trước khi tạo hoặc nhân bản máy chủ Bedrock. Chưa xác minh được chính sách tạo máy chủ bằng NetherNet của agent.' }),
]);
function creationIssue(code, message) {
  return Object.assign(new Error(message.vi), { code, status: 409, errorI18n: { ...message, params: [] } });
}
export function supportsNetherNetCreationPolicy(capability) {
  return capability?.schemaVersion === BEDROCK_TRANSPORT_POLICY.schemaVersion && capability.creation === BEDROCK_TRANSPORT_POLICY.creation;
}
export function requireNetherNetCreationPolicy(capability) {
  if (!supportsNetherNetCreationPolicy(capability)) throw creationIssue('BEDROCK_NETHERNET_NODE_REQUIRED', BEDROCK_TRANSPORT_MESSAGES[1]);
}
function knownNetherNetVersion(version) {
  const match = String(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return false;
  const [major, minor, patch, build] = match.slice(1).map(Number);
  if (![major, minor, patch, build].every(Number.isSafeInteger)) return false;
  return major > 1 || major === 1 && (minor > 26 || minor === 26 && patch >= 50);
}
// Missing catalog metadata may be admitted for the official 26.50+ line, but
// installation rechecks the actual package properties before activation.
// Actual packages must declare NetherNet, except for the 26.60+ engine line
// where RakNet is deprecated and the transport key may no longer be present.
// An explicit RakNet-only package is never treated as a new NetherNet server.
export function selectNewBedrockTransport({ version, packageTransport, actualPackage = false } = {}) {
  const knownDefault = knownNetherNetVersion(version) && (!actualPackage || requiresNetherNet(version));
  if (packageTransport === 'nethernet' || packageTransport === undefined && knownDefault) return 'nethernet';
  throw creationIssue('BEDROCK_NETHERNET_REQUIRED', BEDROCK_TRANSPORT_MESSAGES[0]);
}
const CREATION_ERRORS = Object.freeze({ BEDROCK_NETHERNET_REQUIRED: BEDROCK_TRANSPORT_MESSAGES[0], BEDROCK_NETHERNET_NODE_REQUIRED: BEDROCK_TRANSPORT_MESSAGES[1] });
export function bedrockTransportErrorPayload(error, language = 'en') {
  const message = Object.hasOwn(CREATION_ERRORS, error?.code) ? CREATION_ERRORS[error.code] : null;
  return message ? { error: language === 'vi' ? message.vi : message.en, code: error.code, errorI18n: { ...message, params: [] } } : null;
}
