import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewText, renderMarkdown } from './markdown';

/**
 * The security tests matter most: this output goes straight into innerHTML,
 * so anything the model writes must come back inert.
 */

test('escapes HTML in prose', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), 'script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('escapes HTML inside code fences', () => {
  const html = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!html.includes('<img'), 'img tag must not survive');
  assert.ok(html.includes('&lt;img'));
});

test('rejects javascript: URLs in link syntax', () => {
  const html = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!html.includes('href'), 'no anchor should be produced');
});

test('rejects data: URLs in link syntax', () => {
  const html = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!html.includes('<a '), 'no anchor should be produced');
});

test('renders https links with safe rel attributes', () => {
  const html = renderMarkdown('[Z.ai](https://z.ai/docs)');
  assert.ok(html.includes('href="https://z.ai/docs"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('an attribute-breaking title cannot escape the anchor', () => {
  const html = renderMarkdown('[a" onmouseover="alert(1)](https://example.com)');
  assert.ok(!html.includes('onmouseover="alert'), 'quote must stay escaped');
});

/* ------------------------------------------------------------ structure -- */

test('renders fenced code with a language label', () => {
  const html = renderMarkdown('```python\nprint("hi")\n```');
  assert.ok(html.includes('<figure class="code-block">'));
  assert.ok(html.includes('python'));
  assert.ok(html.includes('print(&quot;hi&quot;)'));
});

test('renders an unterminated fence, as arrives mid-stream', () => {
  const html = renderMarkdown('Here:\n```js\nconst a = 1;');
  assert.ok(html.includes('code-block'));
  assert.ok(html.includes('const a = 1;'));
});

test('renders headings, lists, and inline emphasis', () => {
  const html = renderMarkdown('# Title\n\n- **bold** item\n- *em* item\n');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>em</em>'));
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('renders ordered lists', () => {
  const html = renderMarkdown('1. first\n2. second\n');
  assert.ok(html.includes('<ol>'));
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('renders blockquotes after entity escaping', () => {
  const html = renderMarkdown('> quoted text');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('quoted text'));
  assert.ok(!html.includes('&gt; quoted'), 'the marker should be consumed');
});

test('renders tables inside a scroll container', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  assert.ok(html.includes('table-wrap'));
  assert.ok(html.includes('<th>a</th>'));
  assert.ok(html.includes('<td>2</td>'));
});

test('renders horizontal rules', () => {
  assert.ok(renderMarkdown('---').includes('<hr />'));
});

test('inline code is not further formatted', () => {
  const html = renderMarkdown('use `a * b * c` here');
  assert.ok(html.includes('<code>a * b * c</code>'));
  assert.ok(!html.includes('<em>'));
});

test('terminates on pathological input', () => {
  // A regression guard for the block loop: unusual leading whitespace and
  // stray markers must not spin forever.
  const weird = '   \n\t\n>>>\n***\n|\n1.\n-\n';
  const html = renderMarkdown(weird);
  assert.equal(typeof html, 'string');
});

test('handles empty input', () => {
  assert.equal(renderMarkdown(''), '');
});

/* -------------------------------------------------------------- preview -- */

test('previewText strips markup and truncates', () => {
  const preview = previewText('# Title\n\n```js\ncode\n```\n\nSome **text** here', 20);
  assert.ok(!preview.includes('#'));
  assert.ok(!preview.includes('code'));
  assert.ok(preview.length <= 20);
});
