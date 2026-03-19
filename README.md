# /publish-to-confluence — Claude Code Skill

A Claude Code slash command that converts any Markdown file to Atlassian Document Format (ADF) and publishes it directly to a Confluence page.

```
/publish-to-confluence docs/my-doc.md 1096679454
/publish-to-confluence docs/my-doc.md 1096679454 --title "My Page Title"
```

---

## Installation

### 1. Copy the files

```bash
# Create directories if they don't exist
mkdir -p ~/.claude/commands ~/.claude/scripts

# Copy the command and script
cp commands/publish-to-confluence.md ~/.claude/commands/
cp scripts/md-to-confluence.js       ~/.claude/scripts/
```

No npm packages required — the script uses only Node.js built-ins.

### 2. Set environment variables

Add these to your shell profile (`~/.zprofile`, `~/.bashrc`, or `~/.zshrc`):

```bash
export ATLASSIAN_BASE_URL="https://your-org.atlassian.net"
export ATLASSIAN_EMAIL="your.email@company.com"
export ATLASSIAN_API_TOKEN="your-token-here"
```

Then reload: `source ~/.zprofile`

### 3. Generate an Atlassian API token

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g. `claude-confluence`)
4. Set these scopes:
   - `read:page:confluence`
   - `write:page:confluence`
5. Copy the token and paste it as `ATLASSIAN_API_TOKEN`

> **Note:** Use your classic API token (starts with `ATATT3x...`), not an OAuth app token. The command uses Basic auth (`email:token`).

### 4. Find a Confluence page ID

Open the target page in Confluence → click `···` (More actions) → **Page information**.
The page ID is in the URL: `.../pages/<pageId>/...`

Alternatively, copy it from the browser URL when viewing the page:
```
https://your-org.atlassian.net/wiki/spaces/SPACE/pages/1096679454/Page+Title
                                                        ^^^^^^^^^^
                                                        this is the page ID
```

> **Important:** The page must already exist. This command updates an existing page — it does not create new ones.

---

## Usage

In any Claude Code session:

```
/publish-to-confluence <file.md> <page-id>
/publish-to-confluence <file.md> <page-id> --title "Custom Title"
```

**Examples:**
```
/publish-to-confluence docs/guide.md 1096679454
/publish-to-confluence RFC-72.md 1072758829 --title "RFC-72: Experimentation Platform"
```

---

## What it converts

| Markdown element | Confluence output |
|-----------------|-------------------|
| `# H1` `## H2` … | Heading 1, 2 … |
| `**bold**` `*italic*` | Bold, italic |
| `` `inline code` `` | Inline code |
| `[link](url)` | Hyperlink |
| `~~strikethrough~~` | Strikethrough |
| ` ```lang ` fenced blocks | Code block with syntax highlight |
| `- item` / `1. item` | Bullet / numbered list |
| `\| col \| col \|` tables | Confluence table |
| `> blockquote` | Block quote |
| `---` horizontal rule | Divider |

---

## Troubleshooting

**401 Unauthorized**
- Check `ATLASSIAN_EMAIL` exactly matches your Atlassian account email
- Regenerate the API token — tokens expire or can be revoked

**403 Forbidden / "not permitted to use Confluence"**
- Your Atlassian account may not have a Confluence product seat
- Your organisation may restrict API token access — ask your Atlassian admin to check `admin.atlassian.com → Security → API token controls`

**404 Not Found**
- Verify the page ID is correct
- Confirm the page exists and your account has view access

**Page updates but content looks wrong**
- Run the script directly with `--dry-run` to inspect the ADF output:
  ```bash
  node ~/.claude/scripts/md-to-confluence.js your-file.md --dry-run
  ```

---

## Files

```
claude-plugin/
├── README.md                          ← this file
├── commands/
│   └── publish-to-confluence.md       → copy to ~/.claude/commands/
└── scripts/
    └── md-to-confluence.js            → copy to ~/.claude/scripts/
```
