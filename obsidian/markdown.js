function clipText(text, maxChars) {
  const s = String(text || '');
  const n = Math.max(0, Number(maxChars) || 0);
  return n && s.length > n ? s.slice(0, n) : s;
}

function parseFrontmatter(raw) {
  const frontmatter = {};
  let body = String(raw || '');
  const match = body.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!match) return { frontmatter, body };
  body = body.slice(match[0].length);
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (/^\[.*\]$/.test(val)) {
      frontmatter[key] = val.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    } else {
      frontmatter[key] = val.replace(/^[']|[']$/g, '').replace(/^["]|["]$/g, '');
    }
  }
  return { frontmatter, body };
}

function cleanBody(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)]]/g, (_, a, b) => b || a)
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripCodeForTagScan(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
}

function extractTags(body, frontmatter) {
  const tags = new Set();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) fmTags.forEach(t => tags.add(String(t).replace(/^#/, '').trim()));
  else if (typeof fmTags === 'string') fmTags.split(/[,\s]+/).forEach(t => tags.add(t.replace(/^#/, '').trim()));
  for (const m of stripCodeForTagScan(body).matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    tags.add(m[2]);
  }
  return [...tags].filter(Boolean);
}

function extractTitle(relativePath, body) {
  const h1 = String(body || '').match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return String(relativePath || 'Untitled').split('/').pop().replace(/\.md$/i, '');
}

function parseMarkdownNote({ path, relativePath, content }) {
  const parsed = parseFrontmatter(content);
  const title = extractTitle(relativePath, parsed.body);
  return {
    path,
    relativePath,
    title,
    frontmatter: parsed.frontmatter,
    tags: extractTags(parsed.body, parsed.frontmatter),
    body: cleanBody(parsed.body)
  };
}

module.exports = { clipText, parseMarkdownNote, parseFrontmatter, cleanBody, stripCodeForTagScan, extractTags };
