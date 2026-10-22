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
