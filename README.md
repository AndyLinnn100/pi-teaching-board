# teaching-board

Browser teaching board for pi math-tutoring sessions (http://localhost:7331).
Publishes micro-notes, theorems, and worksheet questions as cards via the
`board` tool. Display-only; Q&A stays in the terminal.

## Activation (allowlist)

The extension activates **only** when the session cwd is inside one of the
directories listed in `config.json` next to this file (copy
`config.example.json` → `config.json` and edit; `config.json` is gitignored
as machine-local):

```json
{
	"allowedDirectories": ["/absolute/path/to/your/math/workspace"]
}
```

- Inside an allowed directory (or any subdirectory): the `board` tool is
  registered, the HTTP server starts on 127.0.0.1:7331, and the session-start
  notification fires.
- Anywhere else: no tool, no server, no notification — the model never sees
  the board.
- The allowlist is re-read at every `session_start`, so edits apply to the
  next session without `/reload`. Matching is path-boundary safe
  (`/home/andy/school/uni/26_27_fall2` does not match) and symlink-normalized.
- Missing or invalid `config.json` fails closed: the board stays disabled and
  a warning is shown at session start.

## Files

- `index.ts` — the extension (loaded automatically; pi loads extension
  subdirectories containing an `index.ts`).
- `config.example.json` — template for the allowlist; copy to `config.json`
  (gitignored, machine-local).
- `webview-assets/` — KaTeX, marked, and client assets, served locally
  (no CDN, works offline).

## Where cards are stored

`BOARD.json` at the workspace root: the nearest ancestor of the session cwd
containing `AGENTS.md` (fallback: session cwd). Settings live in
`BOARD.config.json` there; edit with `/board-settings [key value]`.

## After editing `index.ts`

`/reload` in pi, then hard-refresh the browser (Ctrl+Shift+R).
