import { describe, it, expect } from 'vitest';
import AnsiToHtml from 'ansi-to-html';
import { escapeHtml } from '../utils.js';

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
