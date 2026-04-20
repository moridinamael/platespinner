import dns from 'dns';
import net from 'net';

/**
 * Check whether an IP address belongs to a private/reserved range.
 * Returns true (reject) for unknown formats as a safe default.
 */
export function isPrivateIP(ip) {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::1') return true; // loopback
    const groups = ip.split(':');
    const first = groups[0].toLowerCase();
    if (first.length > 0) {
      const val = parseInt(first, 16);
      if (val >= 0xfc00 && val <= 0xfdff) return true; // fc00::/7
      if (val >= 0xfe80 && val <= 0xfebf) return true; // fe80::/10
    }
    return false;
  }

  return true; // Unknown format — reject to be safe
}

/**
 * Validate a URL for outbound requests: parse, check protocol, resolve DNS,
 * and reject private/reserved IP addresses.
 *
 * @param {string} urlString - The URL to validate
 * @returns {Promise<{parsed: URL, resolvedAddress: string}>}
 * @throws {Error} on invalid URL, disallowed protocol, or private IP
 */
export async function resolveAndValidate(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  let resolvedAddress;
  if (net.isIPv4(parsed.hostname) || net.isIPv6(parsed.hostname)) {
    // Hostname is already an IP literal
    if (isPrivateIP(parsed.hostname)) {
      throw new Error('Access to private/internal addresses is not allowed');
    }
    resolvedAddress = parsed.hostname;
  } else {
    try {
      const { address } = await dns.promises.lookup(parsed.hostname);
      if (isPrivateIP(address)) {
        throw new Error('Access to private/internal addresses is not allowed');
      }
      resolvedAddress = address;
    } catch (err) {
      if (err.message.includes('private') || err.message.includes('internal')) {
        throw err;
      }
      throw new Error(`Cannot resolve hostname: ${err.message}`);
    }
  }

  return { parsed, resolvedAddress };
}
