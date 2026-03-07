import { describe, it, expect } from 'vitest';
import { isPrivateIP, resolveAndValidate } from './netguard.js';

describe('isPrivateIP', () => {
  it('detects IPv4 loopback', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects 10.x.x.x private range', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects 172.16.0.0/12 private range', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects 192.168.x.x private range', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('detects 169.254.x.x link-local range', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
  });

  it('detects 0.0.0.0/8 range', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('detects CGNAT range (100.64.0.0/10)', () => {
    expect(isPrivateIP('100.64.0.1')).toBe(true);
    expect(isPrivateIP('100.127.255.255')).toBe(true);
    expect(isPrivateIP('100.63.255.255')).toBe(false);
    expect(isPrivateIP('100.128.0.0')).toBe(false);
  });

  it('detects benchmark range (198.18.0.0/15)', () => {
    expect(isPrivateIP('198.18.0.1')).toBe(true);
    expect(isPrivateIP('198.19.255.255')).toBe(true);
    expect(isPrivateIP('198.17.255.255')).toBe(false);
    expect(isPrivateIP('198.20.0.0')).toBe(false);
  });

  it('detects IPv6 loopback', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('detects IPv6 private ranges', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fdff::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('handles IPv4-mapped IPv6', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv4 addresses', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
  });

  it('allows public IPv6 addresses', () => {
    expect(isPrivateIP('2606:4700::')).toBe(false);
  });

  it('rejects unknown formats as safe default', () => {
    expect(isPrivateIP('not-an-ip')).toBe(true);
  });
});

describe('resolveAndValidate', () => {
  it('rejects invalid URLs', async () => {
    await expect(resolveAndValidate('not-a-url')).rejects.toThrow('Invalid URL');
  });

  it('rejects non-http/https protocols', async () => {
    await expect(resolveAndValidate('ftp://example.com')).rejects.toThrow('Only http and https');
    await expect(resolveAndValidate('file:///etc/passwd')).rejects.toThrow('Only http and https');
    await expect(resolveAndValidate('data:text/html,<h1>hi</h1>')).rejects.toThrow('Only http and https');
  });

  it('rejects private IP hostnames', async () => {
    await expect(resolveAndValidate('http://127.0.0.1/')).rejects.toThrow('private');
    await expect(resolveAndValidate('http://10.0.0.1/')).rejects.toThrow('private');
    await expect(resolveAndValidate('http://192.168.1.1/')).rejects.toThrow('private');
  });

  it('rejects hostnames resolving to private IPs (localhost)', async () => {
    await expect(resolveAndValidate('http://localhost/')).rejects.toThrow('private');
  });

  it('accepts valid public URLs', async () => {
    const result = await resolveAndValidate('https://example.com/');
    expect(result.parsed).toBeInstanceOf(URL);
    expect(result.parsed.hostname).toBe('example.com');
    expect(result.resolvedAddress).toBeTruthy();
  });

  it('returns parsed URL and resolved address', async () => {
    const result = await resolveAndValidate('https://example.com/path?q=1');
    expect(result.parsed.pathname).toBe('/path');
    expect(result.parsed.search).toBe('?q=1');
    expect(typeof result.resolvedAddress).toBe('string');
  });
});
