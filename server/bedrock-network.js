import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { defaultUdpPorts } from './safety.js';

// This address is supplied by the node administrator. Never infer it from an
// HTTP host header, endpoint hostname, DNS answer or third-party address probe.
export function isPublicGameAddress(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const parts = value.split('.').map(Number), [a, b, c] = parts;
  if (parts.join('.') !== value) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 0 && (c === 0 || c === 2) || b === 88 && c === 99 || b === 168) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113);
}

export function validateGamePublicAddress(value) {
  if (value === undefined) return undefined;
  if (!isPublicGameAddress(value)) throw new Error('Game public address must be a canonical, globally routable IPv4 address.');
  return value;
}

function privateInterface(value) {
  if (!value || value.internal !== false || ![4, 'IPv4'].includes(value.family) || isIP(value.address) !== 4) return false;
  const [a, b] = value.address.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

export function createBedrockNetworkPolicy({ publicAddress, interfaces } = {}) {
  const context = () => {
    let address, observed;
    try { address = typeof publicAddress === 'function' ? publicAddress() : publicAddress; } catch { address = undefined; }
    try { observed = interfaces === undefined ? networkInterfaces() : typeof interfaces === 'function' ? interfaces() : interfaces; } catch { observed = null; }
    const rows = observed && typeof observed === 'object' ? Object.values(observed).flat().filter(value => value && typeof value === 'object') : [];
    const mapped = isPublicGameAddress(address) && rows.some(privateInterface) && !rows.some(value => value.address === address);
    return { address, mapped };
  };
  return Object.freeze({
    get capability() { return Object.freeze({ schemaVersion: 1, automaticNatMapping: context().mapped }); },
    automaticUdpPorts(port, maxPlayers) {
      const range = defaultUdpPorts(port, maxPlayers), { address, mapped } = context();
      return mapped ? `${address}:${range}:${range}` : range;
    },
  });
}
