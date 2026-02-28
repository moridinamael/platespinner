import { platform } from 'os';

/**
 * Convert a Windows path to a WSL path if needed.
 * e.g. "C:\Users\Matt\project" → "/mnt/c/Users/Matt/project"
 * Already-unix paths are returned as-is.
 */
export function toWSLPath(p) {
  if (!p) return p;

  // Already a unix path
  if (p.startsWith('/')) return p;

  // Match Windows drive letter: C:\ or C:/
  const match = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  // Backslashes but no drive letter — just convert slashes
  return p.replace(/\\/g, '/');
}
