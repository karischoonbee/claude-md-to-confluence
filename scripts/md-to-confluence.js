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
 *  Handles: [link](url), **bold**, *italic*, `code`, ~~strikethrough~~
 */
function inlineToAdf(text) {
  const nodes = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_|~~([^~]+)~~/g;
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push({ type: "text", text: text.slice(last, m.index) });

    if (m[1] !== undefined) {
      nodes.push({ type: "text", text: m[1], marks: [{ type: "link", attrs: { href: m[2] } }] });
    } else if (m[3] !== undefined) {
      nodes.push({ type: "text", text: m[3], marks: [{ type: "code" }] });
    } else if (m[4] !== undefined || m[6] !== undefined) {
      nodes.push({ type: "text", text: m[4] || m[6], marks: [{ type: "strong" }] });
    } else if (m[5] !== undefined || m[7] !== undefined) {
      nodes.push({ type: "text", text: m[5] || m[7], marks: [{ type: "em" }] });
    } else if (m[8] !== undefined) {
      nodes.push({ type: "text", text: m[8], marks: [{ type: "strike" }] });
    }

    last = m.index + m[0].length;
  }

  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

function paragraph(inlineText) {
  return { type: "paragraph", content: inlineToAdf(inlineText) };
}

function heading(level, text) {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function codeBlock(code, lang) {
  return {
    type: "codeBlock",
    attrs: { language: lang || "plain" },
    content: [{ type: "text", text: code }],
  };
}

function bulletList(items) {
  return {
    type: "bulletList",
    content: items.map(item => ({
      type: "listItem",
      content: [{ type: "paragraph", content: inlineToAdf(item) }],
    })),
  };
}

function orderedList(items) {
  return {
    type: "orderedList",
    content: items.map(item => ({
      type: "listItem",
      content: [{ type: "paragraph", content: inlineToAdf(item) }],
    })),
  };
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

    // unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s/, "")); i++;
      }
      content.push(bulletList(items)); continue;
    }

    // ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, "")); i++;
      }
      content.push(orderedList(items)); continue;
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
      !/^\d+\.\s/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]); i++;
    }
    if (paraLines.length > 0) content.push(paragraph(paraLines.join(" ")));
  }

  return { type: "doc", version: 1, content };
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

if (dryRun) { console.log(JSON.stringify(adf, null, 2)); process.exit(0); }

const outPath = outOverride ? path.resolve(outOverride) : mdPath.replace(/\.md$/, ".adf.json");
fs.writeFileSync(outPath, JSON.stringify(adf, null, 2));
console.log(`ADF written → ${outPath}`);

if (!push) process.exit(0);

// ── push to confluence ────────────────────────────────────────────────────────

const baseUrl = (process.env.ATLASSIAN_BASE_URL || "").replace(/\/$/, "");
const email   = process.env.ATLASSIAN_EMAIL;
const token   = process.env.ATLASSIAN_API_TOKEN;

if (!baseUrl || !email || !token) {
  console.error([
    "Error: missing Confluence credentials. Set these env vars:",
    "  ATLASSIAN_BASE_URL   e.g. https://your-org.atlassian.net",
    "  ATLASSIAN_EMAIL      your Atlassian account email",
    "  ATLASSIAN_API_TOKEN  generate at: https://id.atlassian.com/manage-profile/security/api-tokens",
  ].join("\n"));
  process.exit(1);
}

(async () => {
  const auth    = Buffer.from(`${email}:${token}`).toString("base64");
  const pageUrl = `${baseUrl}/wiki/rest/api/content/${pageId}`;
  const headers = {
    Authorization:  `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept:         "application/json",
  };

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
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
