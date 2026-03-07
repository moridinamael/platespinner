import { describe, it, expect } from 'vitest';
import AnsiToHtml from 'ansi-to-html';
import { escapeHtml, sanitizeAnsiHtml } from '../utils.js';

describe('Log rendering XSS prevention', () => {
  const ansiConverter = new AnsiToHtml({
    fg: '#959ab0',
    bg: 'transparent',
    newline: true,
    escapeXML: true,
  });

  it('escapes <img onerror=...> in log content', () => {
    const malicious = '<img onerror=alert(1) src=x>';
    const html = ansiConverter.toHtml(malicious);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes <script> tags in log content', () => {
    const malicious = '<script>alert("xss")</script>';
    const html = ansiConverter.toHtml(malicious);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves ANSI color codes while escaping HTML', () => {
    const input = '\x1b[31m<b>not bold</b>\x1b[0m';
    const html = ansiConverter.toHtml(input);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('span');
    expect(html).not.toContain('<b>');
  });

  it('escapeHtml fallback also prevents XSS', () => {
    const malicious = '<img onerror=alert(1) src=x>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
  });

  it('escapeHtml handles ampersands and quotes', () => {
    const input = '"foo" & <bar> \' baz';
    const escaped = escapeHtml(input);
    expect(escaped).toBe('&quot;foo&quot; &amp; &lt;bar&gt; &#39; baz');
  });
});

describe('sanitizeAnsiHtml', () => {
  const ansiConverter = new AnsiToHtml({
    fg: '#959ab0',
    bg: 'transparent',
    newline: true,
    escapeXML: true,
  });

  it('preserves legitimate ansi-to-html span output', () => {
    const input = '\x1b[31mred text\x1b[0m normal';
    const html = ansiConverter.toHtml(input);
    const sanitized = sanitizeAnsiHtml(html);
    expect(sanitized).toContain('<span');
    expect(sanitized).toContain('</span>');
    expect(sanitized).toContain('red text');
    expect(sanitized).toContain('normal');
  });

  it('strips script tags even if somehow present in output', () => {
    const dangerous = '<span style="color:red">safe</span><script>alert(1)</script>';
    const sanitized = sanitizeAnsiHtml(dangerous);
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('</script>');
    expect(sanitized).toContain('alert(1)');
    expect(sanitized).toContain('<span style="color:red">safe</span>');
  });

  it('strips img tags with event handlers', () => {
    const dangerous = '<span>ok</span><img onerror=alert(1) src=x>';
    const sanitized = sanitizeAnsiHtml(dangerous);
    expect(sanitized).not.toContain('<img');
    expect(sanitized).toContain('<span>ok</span>');
  });

  it('strips event handlers from span tags', () => {
    const dangerous = '<span onmouseover="alert(1)" style="color:red">text</span>';
    const sanitized = sanitizeAnsiHtml(dangerous);
    expect(sanitized).not.toContain('onmouseover');
    expect(sanitized).toContain('style="color:red"');
    expect(sanitized).toContain('text');
  });

  it('strips javascript: from style values', () => {
    const dangerous = '<span style="background: javascript:alert(1)">text</span>';
    const sanitized = sanitizeAnsiHtml(dangerous);
    expect(sanitized).not.toContain('javascript:');
  });

  it('strips expression() from style values', () => {
    const dangerous = '<span style="width: expression(alert(1))">text</span>';
    const sanitized = sanitizeAnsiHtml(dangerous);
    expect(sanitized).not.toContain('expression(');
  });

  it('end-to-end: script in log input is safe after full pipeline', () => {
    const maliciousLog = 'normal output\n<script>document.cookie</script>\nmore output';
    const html = ansiConverter.toHtml(maliciousLog);
    const sanitized = sanitizeAnsiHtml(html);
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).toContain('normal output');
    expect(sanitized).toContain('more output');
  });

  it('end-to-end: iframe injection is safe after full pipeline', () => {
    const maliciousLog = '\x1b[32m<iframe src="evil.com"></iframe>\x1b[0m';
    const html = ansiConverter.toHtml(maliciousLog);
    const sanitized = sanitizeAnsiHtml(html);
    expect(sanitized).not.toContain('<iframe');
  });
});
