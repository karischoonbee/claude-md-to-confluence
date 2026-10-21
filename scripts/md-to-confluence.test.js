// Run: node --test scripts/
// Converts small Markdown samples with --dry-run (no credentials, so nothing is fetched or pushed) and checks the ADF.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "md-to-confluence.js");

function convert(markdown, extraArgs = []) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "md2c-")), "in.md");
  fs.writeFileSync(file, markdown);
  const env = { ...process.env, ATLASSIAN_BASE_URL: "", ATLASSIAN_EMAIL: "", ATLASSIAN_API_TOKEN: "" };
  const r = spawnSync(process.execPath, [SCRIPT, file, "--dry-run", ...extraArgs], { env, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  return { doc: JSON.parse(r.stdout), stderr: r.stderr };
}

const texts = nodes => nodes.map(n => n.text || "").join("");

test("a leading H1 is dropped (Confluence shows the title); --keep-h1 keeps it", () => {
  const md = "# Page title\n\nBody.\n";
  const dropped = convert(md);
  assert.strictEqual(dropped.doc.content[0].type, "paragraph");
  assert.match(dropped.stderr, /dropped the leading H1/);
  assert.strictEqual(convert(md, ["--keep-h1"]).doc.content[0].type, "heading");
});

test("nested bullet lists, with a wrapped line continuing its item", () => {
  const { doc } = convert("- top\n  - child one\n    still child one\n  - child two\n- second\n");
  const list = doc.content[0];
  assert.strictEqual(list.type, "bulletList");
  assert.strictEqual(list.content.length, 2);
  const sub = list.content[0].content[1];
  assert.strictEqual(sub.type, "bulletList");
  assert.strictEqual(texts(sub.content[0].content[0].content), "child one still child one");
  assert.strictEqual(sub.content.length, 2);
});

test("a bullet list nested in a numbered list", () => {
  const { doc } = convert("1. one\n2. two\n   - under two\n3. three\n");
  const list = doc.content[0];
  assert.strictEqual(list.type, "orderedList");
  assert.strictEqual(list.content.length, 3);
  assert.strictEqual(list.content[1].content[1].type, "bulletList");
});

test("checkboxes become a task list", () => {
  const { doc } = convert("- [ ] open\n- [x] done\n");
  const tl = doc.content[0];
  assert.strictEqual(tl.type, "taskList");
  assert.deepStrictEqual(tl.content.map(t => t.attrs.state), ["TODO", "DONE"]);
  assert.strictEqual(texts(tl.content[0].content), "open");
});

test("dates, smart links and mentions", () => {
  const { doc, stderr } = convert("Due @date(2026-10-21), see https://example.atlassian.net/browse/X-1 and https://example.com/a. Owner @[Some Person].\n");
  const nodes = doc.content[0].content;
  assert.strictEqual(nodes.find(n => n.type === "date").attrs.timestamp, String(Date.UTC(2026, 9, 21)));
  assert.strictEqual(nodes.find(n => n.type === "inlineCard").attrs.url, "https://example.atlassian.net/browse/X-1");
  const link = nodes.find(n => (n.marks || []).some(m => m.type === "link"));
  assert.strictEqual(link.text, "https://example.com/a");   // the trailing full stop is not part of the URL
  // No credentials: the mention stays plain text, with a warning.
  assert.ok(nodes.some(n => n.type === "text" && n.text === "@Some Person"));
  assert.match(stderr, /mention\(s\) left as plain text/);
});

test("inline marks inside bold and headings; snake_case is not italic", () => {
  const { doc } = convert("## Heading with `code`\n\n**bold `x` text** and snake_case_name\n");
  assert.ok(doc.content[0].content.some(n => (n.marks || []).some(m => m.type === "code")));
  const para = doc.content[1].content;
  const code = para.find(n => n.text === "x");
  assert.deepStrictEqual(code.marks.map(m => m.type), ["code"]);   // ADF allows only a link next to a code mark
  assert.ok(para.find(n => n.text === "bold ").marks.some(m => m.type === "strong"));
  assert.ok(para.every(n => !(n.marks || []).some(m => m.type === "em")));
});
