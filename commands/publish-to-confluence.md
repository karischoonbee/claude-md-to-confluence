---
description: Publish a Markdown file to a Confluence page. Converts MD to ADF and uploads via the REST API.
argument-hint: <file.md> <page-id> [--title "Override Title"]
allowed-tools: Bash
---

# Publish Markdown to Confluence

Convert a local Markdown file to Atlassian Document Format (ADF) and push it to a Confluence page.

## Arguments

The user invoked this command with: $ARGUMENTS

Parse the arguments as:
- First positional arg → the markdown file path
- Second positional arg → the Confluence page ID (numeric, from the page URL)
- `--title "..."` (optional) → override the Confluence page title

## Steps

1. **Check the script exists**

   Run: `ls ~/.claude/scripts/md-to-confluence.js`

   If it is missing, tell the user: "The md-to-confluence script is not installed. See setup instructions: https://github.com/karischoonbee/claude-md-to-confluence"
   Then stop.

2. **Check environment variables**

   Run: `echo "BASE:${ATLASSIAN_BASE_URL:-MISSING} EMAIL:${ATLASSIAN_EMAIL:-MISSING} TOKEN:${ATLASSIAN_API_TOKEN:+SET}"`

   If any are MISSING, print the setup instructions below and stop:

   ```
   Missing Confluence credentials. Add these to your shell profile (~/.zprofile or ~/.bashrc):

     export ATLASSIAN_BASE_URL="https://your-org.atlassian.net"
     export ATLASSIAN_EMAIL="your.email@company.com"
     export ATLASSIAN_API_TOKEN="your-token"

   Generate a token at: https://id.atlassian.com/manage-profile/security/api-tokens
   Required token scopes: read:page:confluence  write:page:confluence

   Then reload your profile: source ~/.zprofile
   ```

3. **Run the script**

   Build the command from the parsed arguments:
   ```
   node ~/.claude/scripts/md-to-confluence.js <file> --push --page-id <pageId> [--title "..."]
   ```

   Run it and report the output to the user. If it fails, show the full error.

4. **Report result**

   On success, print the Confluence page URL from the script output.
   On failure, show the error and suggest checking credentials or the page ID.

## Writing the Markdown

The converter supports, beyond headings, paragraphs, tables, code blocks and blockquotes:

| Markdown | Confluence |
|---|---|
| Sub-items indented under their parent (any depth, bullets and numbers mixed); an indented line continues the item above | Nested lists |
| `- [ ] task` / `- [x] done` | Checkboxes (a task list) |
| `@[Full Name]` or `@[name@company.com]` | A mention (tagged person). Resolved to an account id when the Atlassian credentials are set; an unresolved or ambiguous name stays plain text, with a warning |
| `@date(2026-10-21)` | A date lozenge |
| A bare `https://` URL | A smart link (inline card) on an Atlassian site (Jira issues, Confluence pages); a plain link elsewhere |
| `[text](url)` | A link with that text |
| Code or a link inside bold text or a heading | Keeps its formatting (code inside bold renders as code: ADF allows only a link next to a code mark) |

**Don't repeat the page title.** Confluence shows the title above the body, so a leading `# Title` is dropped automatically (a note says so; `--keep-h1` keeps it). Start the body with the content, or with `##` sections.

**Republishing a page people edit:** before pushing, compare the page's version history (`/wiki/api/v2/pages/<id>/versions`) with the last publish and carry any in-Confluence edits into the Markdown first, or they are overwritten.

## Notes

- The page ID is in the Confluence URL: `/wiki/spaces/.../pages/<pageId>/...`
- The page must already exist — this command updates it, it does not create new pages
- The Confluence account associated with the token must have edit access to the page
