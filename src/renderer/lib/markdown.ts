/**
 * A small Markdown renderer.
 *
 * Safety model: the source is HTML-escaped *first*, and only then are a fixed
 * set of inline and block patterns rewritten into tags. Nothing from the model
 * can therefore produce an element this file did not construct, which is what
 * makes it safe to drop model output into innerHTML. A general-purpose parser
 * plus a sanitiser would be more featureful and much easier to get wrong.
 */

/**
 * Placeholders for extracted spans.
 *
 * They must survive `trim()` and HTML escaping, and must contain no character
 * the inline formatter reacts to — hence no spaces, asterisks, or brackets.
 */
const FENCE_TOKEN = (index: number) => `%%GLMFENCE${index}%%`;
const FENCE_PATTERN = /%%GLMFENCE(\d+)%%/g;

export function renderMarkdown(source: string): string {
  const blocks: string[] = [];

  // Pull fenced code out before escaping so its contents are never re-parsed.
  // An unterminated trailing fence still renders — models stream partial output.
  const withoutFences = source.replace(
    /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g,
    (_match, lang: string, code: string) => {
      const index = blocks.length;
      blocks.push(codeBlock(lang, code.replace(/\n$/, '')));
      // Newlines guarantee the placeholder lands on a line of its own.
      return `\n${FENCE_TOKEN(index)}\n`;
    },
  );

  const html = renderBlocks(escapeHtml(withoutFences), blocks);
  // Catches any placeholder that ended up inline, e.g. inside a list item.
  return html.replace(FENCE_PATTERN, (_m, index: string) => blocks[Number(index)] ?? '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function codeBlock(lang: string, code: string): string {
  const language = /^[\w+-]{1,20}$/.test(lang) ? lang : '';
  return (
    `<figure class="code-block">` +
    `<figcaption><span>${escapeHtml(language || 'code')}</span>` +
    `<button class="code-copy" type="button" data-action="copy-code">Copy</button>` +
    `</figcaption><pre><code>${escapeHtml(code)}</code></pre></figure>`
  );
}

function renderBlocks(text: string, blocks: string[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let index = 0;

  const isBlockStart = (line: string) =>
    /^#{1,6}\s/.test(line) ||
    /^\s*&gt;/.test(line) ||
    /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    line.includes('%%GLMFENCE');

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    // A code-fence placeholder on its own line becomes the block directly.
    const fence = /^%%GLMFENCE(\d+)%%$/.exec(line.trim());
    if (fence) {
      out.push(blocks[Number(fence[1])] ?? '');
      index++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      index++;
      continue;
    }

    // `>` was turned into `&gt;` by escapeHtml above.
    if (/^\s*&gt;\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*&gt;\s?/, ''));
        index++;
      }
      out.push(`<blockquote>${renderBlocks(quoted.join('\n'), blocks)}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const pattern = isOrdered ? ordered : bullet;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) {
        let item = lines[index].replace(pattern, '');
        index++;
        // Absorb indented continuation lines into the same item.
        while (
          index < lines.length &&
          /^\s{2,}\S/.test(lines[index]) &&
          !pattern.test(lines[index])
        ) {
          item += ' ' + lines[index].trim();
          index++;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(isOrdered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])
    ) {
      const table = renderTable(lines, index);
      if (table) {
        out.push(table.html);
        index = table.next;
        continue;
      }
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
    } else {
      // A line the block rules recognised but no branch consumed. Emit it as a
      // paragraph so it is never silently dropped, and always make progress.
      out.push(`<p>${inline(lines[index])}</p>`);
      index++;
    }
  }

  return out.join('\n');
}

function renderTable(lines: string[], start: number): { html: string; next: number } | null {
  const split = (row: string) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const header = split(lines[start]);
  if (header.length < 2) return null;

  let index = start + 2;
  const rows: string[][] = [];
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(split(lines[index]));
    index++;
  }

  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('');
  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index,
  };
}

function inline(text: string): string {
  // Inline code is lifted out first. Replacing it in place would not protect
  // it: the emphasis and link passes that follow would still see its contents,
  // so `a * b * c` would grow an <em> in the middle of the code span.
  const spans: string[] = [];
  const shielded = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    spans.push(code);
    return `%%GLMCODE${spans.length - 1}%%`;
  });

  const formatted = shielded
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Only http(s) URLs become anchors, so a `javascript:` URL can never reach
    // an href no matter what the model emits.
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /(^|\s)(https?:\/\/[^\s<]+[^\s<.,:;"\')\]])/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );

  // The span contents were escaped by escapeHtml before they got here.
  return formatted.replace(
    /%%GLMCODE(\d+)%%/g,
    (_m, index: string) => `<code>${spans[Number(index)] ?? ''}</code>`,
  );
}

/** Plain-text preview for a conversation list row. */
export function previewText(markdown: string, limit = 90): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
