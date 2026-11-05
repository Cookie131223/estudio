// Markdown mínimo e seguro (escapa HTML antes de formatar).
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(src) {
  const text = esc(String(src || '').replace(/\r/g, ''));
  const out = [];
  const blocks = text.split(/```/);
  blocks.forEach((blk, bi) => {
    if (bi % 2 === 1) {
      const body = blk.replace(/^[a-zA-Z0-9_-]*\n/, '');
      out.push(`<pre><code>${body.replace(/\n$/, '')}</code></pre>`);
      return;
    }
    let list = null;
    const li = (it) => `<li>${inline(it.text)}${it.sub.length ? `<ul>${it.sub.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}</li>`;
    const flush = () => { if (list) { out.push(`<${list.t}${list.t === 'ol' && list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map(li).join('')}</${list.t}>`); list = null; } };
    let para = [];
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    for (const line of blk.split('\n')) {
      const ul = line.match(/^(\s*)[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (ul && ul[1].length >= 2 && list && list.items.length) {
        list.items[list.items.length - 1].sub.push(ul[2]);
      } else if (ul || ol) {
        flushP();
        const t = ul ? 'ul' : 'ol';
        if (!list || list.t !== t) { flush(); list = { t, items: [], start: ol ? Number(ol[1]) : 1 }; }
        list.items.push({ text: ul ? ul[2] : ol[2], sub: [] });
      } else if (h) {
        flushP(); flush();
        out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      } else if (!line.trim()) {
        flushP();
      } else {
        flush();
        para.push(line);
      }
    }
    flushP(); flush();
  });
  return out.join('');
}
