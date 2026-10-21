#!/usr/bin/env node
/**
 * md-to-confluence.js
 * Convert a Markdown file to ADF (Atlassian Document Format) and optionally
 * push it to a Confluence page via the REST API.
 *
 * Usage:
 *   node ~/.claude/scripts/md-to-confluence.js <file.md>
 *   node ~/.claude/scripts/md-to-confluence.js <file.md> --push --page-id <pageId>
 *   node ~/.claude/scripts/md-to-confluence.js <file.md> --push --page-id <pageId> --title "My Page"
 *
 * Flags:
 *   --push              Push ADF to Confluence after converting
 *   --page-id <id>      Confluence page ID to update (required with --push)
 *   --title <title>     Override the Confluence page title (optional)
 *   --out <path>        Write ADF JSON to a custom path instead of <file>.adf.json
 *   --dry-run           Print ADF to stdout without writing files or pushing
 *   --keep-h1           Keep a leading "# Title" (dropped by default: Confluence shows the page title)
 *
 * Markdown extras: nested lists, "- [ ]" / "- [x]" checkboxes, @[Full Name] mentions, @date(YYYY-MM-DD),
 * bare URLs (smart links on Atlassian sites).
 *
 * Required env vars for --push:
 *   ATLASSIAN_BASE_URL    e.g. https://your-org.atlassian.net
 *   ATLASSIAN_EMAIL       Your Atlassian account email
 *   ATLASSIAN_API_TOKEN   API token from id.atlassian.com/manage-profile/security/api-tokens
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── markdown → ADF converter ─────────────────────────────────────────────────

/** Parse inline markdown text into an array of ADF inline nodes.
 *  Handles: [link](url), **bold**, *italic*, `code`, ~~strikethrough~~, and
 *    @[Full Name] or @[email]  → a mention (resolved to an account id on --push / --resolve; plain text otherwise)
 *    @date(YYYY-MM-DD)         → a date lozenge
 *    a bare https:// URL       → a smart link (inline card) on an Atlassian site, a plain link elsewhere
 */
const MENTIONS = [];   // mention nodes to resolve after parsing: { node, query }

function isAtlassianUrl(url) {
  try {
    const host = new URL(url).hostname;
    const base = process.env.ATLASSIAN_BASE_URL ? new URL(process.env.ATLASSIAN_BASE_URL).hostname : null;
    return host === base || host.endsWith(".atlassian.net");
  } catch { return false; }
}

function urlNode(url) {
  return isAtlassianUrl(url)
    ? { type: "inlineCard", attrs: { url } }
    : { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] };
}

function inlineToAdf(text) {
  const nodes = [];
  // bold may contain `code` or a link (with * inside); _x_ only at word boundaries, so snake_case names stay literal
  const re = /@\[([^\]]+)\]|@date\((\d{4}-\d{2}-\d{2})\)|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*((?:`[^`]*`|[^*])+)\*\*|\*([^*\s][^*]*)\*|\b__([^_]+)__\b|\b_([^_]+)_\b|~~([^~]+)~~/g;
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push({ type: "text", text: text.slice(last, m.index) });

    if (m[1] !== undefined) {
      const node = { type: "mention", attrs: { id: "", text: `@${m[1]}` } };
      MENTIONS.push({ node, query: m[1].trim() });
      nodes.push(node);
    } else if (m[2] !== undefined) {
      nodes.push({ type: "date", attrs: { timestamp: String(Date.parse(`${m[2]}T00:00:00Z`)) } });
    } else if (m[3] !== undefined) {
      nodes.push(urlNode(m[3]));
    } else if (m[4] !== undefined) {
      nodes.push({ type: "text", text: m[4], marks: [{ type: "link", attrs: { href: m[5] } }] });
    } else if (m[6] !== undefined) {
      nodes.push({ type: "text", text: m[6], marks: [{ type: "code" }] });
    } else if (m[7] !== undefined || m[9] !== undefined) {
      nodes.push(...withMark(inlineToAdf(m[7] || m[9]), "strong"));
    } else if (m[8] !== undefined || m[10] !== undefined) {
      nodes.push(...withMark(inlineToAdf(m[8] || m[10]), "em"));
    } else if (m[11] !== undefined) {
      nodes.push(...withMark(inlineToAdf(m[11]), "strike"));
    }

    last = m.index + m[0].length;
  }

  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

/** Add a mark to inline nodes. ADF allows only a link next to a code mark, so code inside bold stays plain code. */
function withMark(nodes, type) {
  return nodes.map(n => n.type !== "text" || (n.marks || []).some(mk => mk.type === "code")
    ? n : { ...n, marks: [...(n.marks || []), { type }] });
}

function paragraph(inlineText) {
  return { type: "paragraph", content: inlineToAdf(inlineText) };
}

function heading(level, text) {
  return { type: "heading", attrs: { level }, content: inlineToAdf(text) };
}

function codeBlock(code, lang) {
  return {
    type: "codeBlock",
    attrs: { language: lang || "plain" },
    content: [{ type: "text", text: code }],
  };
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

/** Parse a (possibly nested) list starting at lines[i]. A deeper-indented item starts a sublist inside the previous
 *  item; an indented non-item line continues the previous item's text. Returns [node, nextIndex]. */
function parseList(lines, i) {
  const first = lines[i].match(LIST_RE);
  const indent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const node = { type: ordered ? "orderedList" : "bulletList", content: [] };
  if (ordered && parseInt(first[2], 10) !== 1) node.attrs = { order: parseInt(first[2], 10) };
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m) {
      const prev = node.content[node.content.length - 1];
      if (prev && /^\s+\S/.test(lines[i]) && lines[i].match(/^\s*/)[0].length > indent) {
        const para = prev.content[prev.content.length - 1];
        if (para.type === "paragraph") { prev.text += " " + lines[i].trim(); para.content = inlineToAdf(prev.text); i++; continue; }
      }
      break;
    }
    const level = m[1].length;
    if (level < indent) break;
    if (level > indent && node.content.length > 0) {
      const [sub, next] = parseList(lines, i);
      node.content[node.content.length - 1].content.push(sub);
      i = next; continue;
    }
    if (/^\d/.test(m[2]) !== ordered) break;
    node.content.push({ type: "listItem", text: m[3], content: [{ type: "paragraph", content: inlineToAdf(m[3]) }] });
    i++;
  }
  node.content.forEach(li => delete li.text);
  return [toTaskList(node), i];
}

const TASK_RE = /^\[( |x|X)\]\s+/;

/** A list whose every item starts with [ ] or [x] becomes an ADF task list (checkboxes). Nested lists inside a task
 *  stay as they are, after the task. */
function toTaskList(list) {
  const firstText = li => (li.content[0].content || []).map(n => n.text || "").join("");
  if (!list.content.length || !list.content.every(li => TASK_RE.test(firstText(li)))) return list;
  let n = 0;
  const content = [];
  for (const li of list.content) {
    const raw = firstText(li);
    const done = /^\[(x|X)\]/.test(raw);
    const inline = li.content[0].content.slice();
    inline[0] = { ...inline[0], text: inline[0].text.replace(TASK_RE, "") };
    if (!inline[0].text) inline.shift();
    content.push({ type: "taskItem", attrs: { localId: `task-${Date.now()}-${n++}`, state: done ? "DONE" : "TODO" }, content: inline });
    // ADF allows only task lists inside a task list: a nested plain list is folded into the task's text
    for (const sub of li.content.slice(1)) {
      if (sub.type === "taskList") { content.push(sub); continue; }
      const items = sub.content.map(it => (it.content[0].content || []).map(t => t.text || "").join(""));
      content[content.length - 1].content.push({ type: "text", text: ` (${items.join("; ")})` });
    }
  }
  return { type: "taskList", attrs: { localId: `tasklist-${Date.now()}-${n}` }, content };
}

function tableNode(headerCells, rows) {
  function cell(text, isHeader) {
    return {
      type: isHeader ? "tableHeader" : "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: "paragraph", content: inlineToAdf(text.trim()) }],
    };
  }
  return {
    type: "table",
    attrs: { layout: "default" },
    content: [
      { type: "tableRow", content: headerCells.map(h => cell(h, true)) },
      ...rows.map(row => ({ type: "tableRow", content: row.map(c => cell(c, false)) })),
    ],
  };
}

function blockquote(text) {
  return {
    type: "blockquote",
    content: [{ type: "paragraph", content: inlineToAdf(text) }],
  };
}

function parseTable(lines) {
  const rows = lines
    .filter(l => !/^\s*\|?\s*[-:]+[-| :]*\s*\|?\s*$/.test(l))
    .map(l => l.replace(/^\||\|$/g, "").split("|"));
  return { header: rows[0] || [], body: rows.slice(1) };
}

function mdToAdf(markdown) {
  const content = [];
  const lines   = markdown.split("\n");
  let i = 0;

  // Confluence shows the page title above the body, so a leading "# Title" would repeat it: drop it.
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  if (i < lines.length && /^#\s+/.test(lines[i]) && !process.argv.includes("--keep-h1")) {
    console.error(`Note: dropped the leading H1 ("${lines[i].replace(/^#\s+/, "").trim()}"); Confluence shows the page title. --keep-h1 keeps it.`);
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      content.push(codeBlock(codeLines.join("\n"), lang));
      i++; continue;
    }

    // heading
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) { content.push(heading(hMatch[1].length, hMatch[2].trim())); i++; continue; }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: "rule" }); i++; continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const bqLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^>\s?/, "")); i++;
      }
      content.push(blockquote(bqLines.join(" "))); continue;
    }

    // table
    if (/\|/.test(line) && !(/^\s*$/.test(line))) {
      const nextLine = lines[i + 1] || "";
      if (/^\|/.test(line) || /^\|?[-| :]+\|/.test(nextLine)) {
        const tableLines = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          tableLines.push(lines[i]); i++;
        }
        if (tableLines.length >= 2) {
          const { header, body } = parseTable(tableLines);
          content.push(tableNode(header, body));
        }
        continue;
      }
    }

    // list (bullet or ordered, nested by indentation)
    if (LIST_RE.test(line)) {
      const [node, next] = parseList(lines, i);
      content.push(node); i = next; continue;
    }

    // paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[\s]*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]); i++;
    }
    if (paraLines.length > 0) content.push(paragraph(paraLines.join(" ")));
  }

  return { type: "doc", version: 1, content };
}

// ── mentions ─────────────────────────────────────────────────────────────────

/** Resolve each @[Name] / @[email] to an Atlassian account id (Jira user search, then Confluence user search).
 *  An unresolved or ambiguous mention becomes plain text, with a warning. */
async function resolveMentions(baseUrl, headers) {
  const cache = {};
  for (const { node, query } of MENTIONS) {
    if (!(query in cache)) cache[query] = await findUser(baseUrl, headers, query);
    const user = cache[query];
    if (user) { node.attrs = { id: user.accountId, text: `@${user.displayName}` }; continue; }
    console.error(`Warning: could not resolve @[${query}] to one user; left as plain text.`);
    node.type = "text"; node.text = `@${query}`; delete node.attrs;
  }
}

async function findUser(baseUrl, headers, query) {
  const exact = list => {
    const q = query.toLowerCase();
    const hits = list.filter(u => (u.displayName || "").toLowerCase() === q || (u.emailAddress || "").toLowerCase() === q);
    return hits.length === 1 ? hits[0] : (list.length === 1 ? list[0] : null);
  };
  try {
    const r = await fetch(`${baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(query)}`, { headers });
    if (r.ok) {
      const users = (await r.json()).filter(u => u.accountType === "atlassian" && u.active !== false);
      const u = exact(users); if (u) return u;
    }
  } catch { /* fall through to Confluence */ }
  try {
    const cql = encodeURIComponent(`type=user and user.fullname~"${query.replace(/"/g, "")}"`);
    const r = await fetch(`${baseUrl}/wiki/rest/api/search/user?cql=${cql}&limit=10`, { headers });
    if (r.ok) {
      const users = (await r.json()).results.map(x => x.user).filter(Boolean)
        .map(u => ({ accountId: u.accountId, displayName: u.displayName || u.publicName, emailAddress: u.email }));
      return exact(users);
    }
  } catch { /* unresolved */ }
  return null;
}

// ── argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage:
  node ~/.claude/scripts/md-to-confluence.js <file.md>
  node ~/.claude/scripts/md-to-confluence.js <file.md> --push --page-id <pageId>
  node ~/.claude/scripts/md-to-confluence.js <file.md> --push --page-id <pageId> --title "Page Title"

Flags:
  --push              Push ADF to Confluence after converting
  --page-id <id>      Confluence page ID to update (required with --push)
  --title <title>     Override the Confluence page title (optional)
  --out <path>        Write ADF JSON to a custom path instead of <file>.adf.json
  --dry-run           Print ADF to stdout without writing files or pushing
  --keep-h1           Keep a leading "# Title" (dropped by default: Confluence shows the page title)

Markdown extras:
  - [ ] / - [x] item  checkboxes (a task list)
  @[Full Name]        mention (or @[email]); resolved to an account id when credentials are set
  @date(2026-10-21)   date lozenge
  bare https:// URL   smart link on an Atlassian site, plain link elsewhere
  nested lists        indent sub-items under their parent; an indented line continues the item

Required env vars for --push:
  ATLASSIAN_BASE_URL   e.g. https://your-org.atlassian.net
  ATLASSIAN_EMAIL      Atlassian account email
  ATLASSIAN_API_TOKEN  API token from id.atlassian.com/manage-profile/security/api-tokens
`);
  process.exit(0);
}

function getFlag(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputFile     = args.find(a => !a.startsWith("--"));
const push          = args.includes("--push");
const dryRun        = args.includes("--dry-run");
const pageId        = getFlag("--page-id");
const titleOverride = getFlag("--title");
const outOverride   = getFlag("--out");

if (!inputFile) { console.error("Error: no input .md file specified."); process.exit(1); }
if (push && !pageId) { console.error("Error: --push requires --page-id <pageId>"); process.exit(1); }

// ── convert ───────────────────────────────────────────────────────────────────

const mdPath = path.resolve(inputFile);
if (!fs.existsSync(mdPath)) { console.error(`Error: file not found: ${mdPath}`); process.exit(1); }

const adf = mdToAdf(fs.readFileSync(mdPath, "utf8"));

const baseUrl = (process.env.ATLASSIAN_BASE_URL || "").replace(/\/$/, "");
const email   = process.env.ATLASSIAN_EMAIL;
const token   = process.env.ATLASSIAN_API_TOKEN;
const haveCreds = Boolean(baseUrl && email && token);
const authHeaders = haveCreds ? {
  Authorization:  `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  "Content-Type": "application/json",
  Accept:         "application/json",
} : null;

(async () => {
  // Mentions need an account id: resolve them whenever credentials are set (also for --dry-run and --out).
  if (MENTIONS.length) {
    if (haveCreds) await resolveMentions(baseUrl, authHeaders);
    else {
      console.error(`Warning: ${MENTIONS.length} mention(s) left as plain text (no Atlassian credentials to resolve them).`);
      for (const { node, query } of MENTIONS) { node.type = "text"; node.text = `@${query}`; delete node.attrs; }
    }
  }

  if (dryRun) { console.log(JSON.stringify(adf, null, 2)); return; }

  const outPath = outOverride ? path.resolve(outOverride) : mdPath.replace(/\.md$/, ".adf.json");
  fs.writeFileSync(outPath, JSON.stringify(adf, null, 2));
  console.log(`ADF written → ${outPath}`);

  if (push) await pushPage();
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });

// ── push to confluence ────────────────────────────────────────────────────────

async function pushPage() {
if (!haveCreds) {
  console.error([
    "Error: missing Confluence credentials. Set these env vars:",
    "  ATLASSIAN_BASE_URL   e.g. https://your-org.atlassian.net",
    "  ATLASSIAN_EMAIL      your Atlassian account email",
    "  ATLASSIAN_API_TOKEN  generate at: https://id.atlassian.com/manage-profile/security/api-tokens",
  ].join("\n"));
  process.exit(1);
}
  const pageUrl = `${baseUrl}/wiki/rest/api/content/${pageId}`;
  const headers = authHeaders;

  console.log(`Fetching page ${pageId}...`);
  const getRes = await fetch(`${pageUrl}?expand=version,space`, { headers });
  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`GET page failed (${getRes.status}): ${body}`);
  }
  const page           = await getRes.json();
  const currentVersion = page.version?.number ?? 1;
  const title          = titleOverride || page.title;

  console.log(`Updating "${title}" — version ${currentVersion} → ${currentVersion + 1}`);

  const putRes = await fetch(pageUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      id:     pageId,
      type:   "page",
      status: "current",
      title,
      space:  { key: page.space.key },
      body: {
        atlas_doc_format: {
          value:          JSON.stringify(adf),
          representation: "atlas_doc_format",
        },
      },
      version: { number: currentVersion + 1 },
    }),
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`PUT page failed (${putRes.status}): ${body}`);
  }

  console.log(`Done → ${baseUrl}/wiki/spaces/${page.space.key}/pages/${pageId}`);
}
