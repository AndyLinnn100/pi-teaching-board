/**
 * teaching-board/index.ts — browser teaching board for pi tutoring sessions.
 *
 * The browser (http://localhost:7331) shows a curated board of math cards
 * (micro-notes, theorems, worksheet questions) published by the tutor via the
 * `board` tool. It is a DISPLAY-ONLY surface: no transcript mirroring, no
 * input path — all Q&A happens in the terminal.
 *
 * Layout: fixed left sidebar (course + time filters), content area with
 * date-grouped cards.
 *
 * - Allowlist: config.json next to this file lists allowedDirectories. The
 *   board tool, board loading, server, and start notification activate only
 *   when the session cwd is inside one of them (path-boundary and symlink
 *   safe). config.json is re-read at every session_start, so edits apply to
 *   the next session without /reload; missing/invalid config fails closed
 *   (board disabled, with a warning when the UI allows it).
 * - Entries persist to BOARD.json at the workspace root (nearest ancestor of
 *   the session cwd containing AGENTS.md; fallback cwd) as a pretty-printed
 *   JSON array — one indented block per card, stable key order — for easy
 *   manual reading/editing. A legacy BOARD.jsonl is migrated automatically
 *   (old file kept). The file is rewritten atomically (tmp + rename) on
 *   publish; a corrupt file is backed up (BOARD.corrupt-<ts>.json) before
 *   starting empty.
 * - Settings live in BOARD.config.json (same root): theme, accent, fontSize,
 *   mathScale, cardOrder, defaultFilter, maxCards. Read per request with an
 *   mtime cache — hand edits and /board-settings apply live, no /reload.
 * - Math renders via KaTeX, markdown via marked — served locally from
 *   webview-assets/ next to this file (no CDN, works offline).
 * - Binds 127.0.0.1 only. PI_WEBVIEW_PORT overrides the port. If the port is
 *   in use, this instance stays dormant.
 *
 * Commands: /board-settings [key value]   TUI-side settings editor.
 *
 * Activate code changes: /reload in pi + hard-refresh the browser (Ctrl+Shift+R).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number.isInteger(Number(process.env.PI_WEBVIEW_PORT)) && Number(process.env.PI_WEBVIEW_PORT) > 0
	? Number(process.env.PI_WEBVIEW_PORT)
	: 7331;
const HOST = "127.0.0.1";
const ASSETS_DIR = fileURLToPath(new URL("./webview-assets/", import.meta.url));
const ALLOWLIST_FILE = fileURLToPath(new URL("./config.json", import.meta.url));

const MIME: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};

type BoardKind = "note" | "theorem" | "question";

type BoardEntry = {
	id: string;
	ts: number;
	kind: BoardKind;
	title: string;
	body: string;
	course?: string;
	topic?: string;
	hint?: string;
	solution?: string;
};

type BoardConfig = {
	theme: "dark" | "light";
	accent: string;
	fontSize: number;
	mathScale: number;
	cardOrder: "oldest-first" | "newest-first";
	defaultFilter: string;
	maxCards: number;
};

const DEFAULT_CONFIG: BoardConfig = {
	theme: "dark",
	accent: "#4a7ec2",
	fontSize: 15,
	mathScale: 1,
	cardOrder: "newest-first",
	defaultFilter: "all",
	maxCards: 0,
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

let server: Server | undefined;
let boardFile: string | undefined;
let configFile: string | undefined;
let entries: BoardEntry[] = [];
let version = 0;
let idCounter = 0;
let config: BoardConfig = { ...DEFAULT_CONFIG };
let configMtimeMs = -1;
let boardActive = false;
let boardToolRegistered = false;

const KEY_ORDER = ["id", "ts", "kind", "course", "topic", "title", "body", "hint", "solution"] as const;

/** Canonical key order so the file reads consistently. */
function orderedEntry(e: BoardEntry): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of KEY_ORDER) {
		// SAFETY: BoardEntry is a plain JSON object; this is a read-only property view, no structural change.
		const v = (e as unknown as Record<string, unknown>)[k];
		if (v !== undefined) out[k] = v;
	}
	// preserve any unexpected extra keys at the end
	for (const k of Object.keys(e)) {
		if (k in out) continue;
		// SAFETY: same read-only property view, values are passed through verbatim.
		out[k] = (e as unknown as Record<string, unknown>)[k];
	}
	return out;
}

/** Atomic pretty-printed save of the whole board. */
function saveBoard(file: string) {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(entries.map(orderedEntry), null, "\t") + "\n", "utf8");
	renameSync(tmp, file);
}

/** Load a JSONL board (legacy) — returns parsed entries or [] on failure. */
function parseJsonl(text: string): BoardEntry[] {
	const out: BoardEntry[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as BoardEntry;
			if (e && typeof e.id === "string" && typeof e.body === "string") out.push(e);
		} catch {
			// skip malformed line
		}
	}
	return out;
}

function newId(): string {
	idCounter++;
	return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Nearest ancestor (or self) of startDir containing AGENTS.md; fallback startDir. */
function findWorkspaceRoot(startDir: string): string {
	try {
		let dir = startDir;
		for (;;) {
			if (existsSync(join(dir, "AGENTS.md"))) return dir;
			const parent = dirname(dir);
			if (parent === dir) return startDir;
			dir = parent;
		}
	} catch {
		return startDir;
	}
}

/** Resolve a path through symlinks when possible; fall back to the raw string. */
function toReal(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** True when cwd equals dir or lies underneath it (path-boundary aware, symlink-normalized). */
function isUnderOrAt(cwd: string, dir: string): boolean {
	const root = toReal(dir);
	const target = toReal(cwd);
	return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

type AllowlistResult = { dirs: string[]; error?: string };

/**
 * Read config.json next to this file; re-read per session so hand edits apply
 * without /reload. Fails closed: any missing/invalid config yields no dirs.
 */
function loadAllowedDirectories(): AllowlistResult {
	if (!existsSync(ALLOWLIST_FILE)) return { dirs: [], error: "config.json not found" };
	try {
		const raw = JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8")) as { allowedDirectories?: unknown };
		if (!Array.isArray(raw.allowedDirectories)) {
			return { dirs: [], error: "config.json has no allowedDirectories array" };
		}
		const dirs = raw.allowedDirectories
			.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
			.map((d) => d.trim());
		return { dirs };
	} catch {
		return { dirs: [], error: "config.json is unreadable or invalid JSON" };
	}
}

function sanitizeConfig(raw: unknown): BoardConfig {
	const c = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return c;
	const r = raw as Record<string, unknown>;
	if (r.theme === "dark" || r.theme === "light") c.theme = r.theme;
	if (typeof r.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(r.accent)) c.accent = r.accent;
	if (typeof r.fontSize === "number" && r.fontSize >= 10 && r.fontSize <= 24) c.fontSize = r.fontSize;
	if (typeof r.mathScale === "number" && r.mathScale >= 0.8 && r.mathScale <= 2) c.mathScale = r.mathScale;
	if (r.cardOrder === "oldest-first" || r.cardOrder === "newest-first") c.cardOrder = r.cardOrder;
	if (typeof r.defaultFilter === "string" && r.defaultFilter.trim()) c.defaultFilter = r.defaultFilter.trim();
	if (typeof r.maxCards === "number" && Number.isInteger(r.maxCards) && r.maxCards >= 0) c.maxCards = r.maxCards;
	return c;
}

/** Reload config when the file's mtime changed. Cheap on every request. */
function refreshConfig() {
	if (!configFile) return;
	try {
		const mtime = statSync(configFile).mtimeMs;
		if (mtime !== configMtimeMs) {
			configMtimeMs = mtime;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(configFile, "utf8"));
			} catch {
				raw = null; // corrupt file → defaults
			}
			config = sanitizeConfig(raw);
		}
	} catch {
		// no config file yet — keep defaults
		configMtimeMs = -1;
	}
}

function loadBoard(file: string) {
	entries = [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (Array.isArray(parsed)) {
			for (const e of parsed) {
				if (e && typeof e.id === "string" && typeof e.body === "string") entries.push(e as BoardEntry);
			}
		} else {
			throw new Error("not an array");
		}
	} catch {
		if (existsSync(file)) {
			// keep the broken file for inspection instead of silently discarding it
			try {
				copyFileSync(file, `${file.replace(/\.json$/, "")}.corrupt-${Date.now().toString(36)}.json`);
			} catch {
				// backup is best-effort
			}
		}
		entries = [];
	}
	version++;
}

function appendEntry(file: string, e: BoardEntry) {
	entries.push(e);
	saveBoard(file);
	version++;
}

function serveAsset(rel: string, res: ServerResponse): boolean {
	const safe = rel
		.split("/")
		.filter((p) => p && p !== "." && p !== "..")
		.join("/");
	if (!safe) return false;
	const ext = extname(safe).toLowerCase();
	const mime = MIME[ext];
	if (!mime) return false;
	const filePath = join(ASSETS_DIR, safe);
	if (!existsSync(filePath)) return false;
	try {
		const body = readFileSync(filePath);
		res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
		res.end(body);
		return true;
	} catch {
		return false;
	}
}

function configBootstrap(cfg: BoardConfig): string {
	const json = JSON.stringify({
		theme: cfg.theme,
		accent: cfg.accent,
		fontSize: cfg.fontSize,
		mathScale: cfg.mathScale,
	});
	return `<script>(function(){var c=${json};var d=document.documentElement;d.dataset.theme=c.theme;var s=d.style;s.setProperty("--accent",c.accent);s.setProperty("--font-size",c.fontSize+"px");s.setProperty("--math-scale",c.mathScale);})();</script>`;
}

function requestListener(req: IncomingMessage, res: ServerResponse) {
	const url = req.url ?? "/";
	if (url === "/" || url === "/index.html") {
		refreshConfig();
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(HTML_PAGE.replace("<!--CONFIG-->", configBootstrap(config)));
		return;
	}
	if (url.startsWith("/assets/")) {
		const rel = decodeURIComponent(url.slice("/assets/".length));
		if (!serveAsset(rel, res)) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
		}
		return;
	}
	if (url === "/board.json") {
		refreshConfig();
		const payload = JSON.stringify({ version, config, entries });
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		res.end(payload);
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
}

function startServer(ctx: ExtensionContext): Promise<void> {
	return new Promise((resolve) => {
		const s = createServer(requestListener);
		s.on("error", (err: NodeJS.ErrnoException) => {
			server = undefined;
			if (ctx.hasUI) {
				if (err.code === "EADDRINUSE") {
					ctx.ui.notify(`webview: port ${PORT} in use — board off (another session?)`, "warning");
				} else {
					ctx.ui.notify(`webview: server error (${err.code ?? err.message})`, "error");
				}
			}
			resolve();
		});
		s.listen(PORT, HOST, () => {
			server = s;
			if (ctx.hasUI) ctx.ui.notify(`teaching board: http://${HOST}:${PORT} (${entries.length} cards)`, "info");
			resolve();
		});
	});
}

function registerBoardTool(pi: ExtensionAPI) {
	if (boardToolRegistered) return; // register once per process; first allowed session wins
	boardToolRegistered = true;
	pi.registerTool({
		name: "board",
		label: "Teaching board",
		description:
			"Publish a card to the student's browser teaching board (http://localhost:7331). " +
			"Kinds: 'note' (micro-note / concept explanation), 'theorem' (statement + optional proof sketch), " +
			"'question' (worksheet item — hint & solution render collapsed on the board). " +
			"Publish WHILE explaining, not after the session. The board is display-only; Q&A stays in the terminal.",
		parameters: Type.Object({
			kind: Type.Unsafe<{ type: "string"; enum: BoardKind[] }>({
				type: "string",
				enum: ["note", "theorem", "question"],
				description: "Card kind",
			}),
			title: Type.String({ description: "Short card title" }),
			body: Type.String({ description: "Markdown; math as $...$ inline or $$...$$ display" }),
			course: Type.Optional(Type.String({ description: "Course folder name, e.g. math3033_real_analysis" })),
			topic: Type.Optional(Type.String({ description: "Topic slug, e.g. limits" })),
			hint: Type.Optional(Type.String({ description: "Question hint (collapsed until clicked)" })),
			solution: Type.Optional(Type.String({ description: "Question solution (collapsed until clicked)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const file = boardFile ?? join(findWorkspaceRoot(ctx.cwd ?? process.cwd()), "BOARD.json");
				const e: BoardEntry = {
					id: newId(),
					ts: Date.now(),
					kind: params.kind,
					title: params.title,
					body: params.body,
					course: params.course || undefined,
					topic: params.topic || undefined,
					hint: params.hint || undefined,
					solution: params.solution || undefined,
				};
				appendEntry(file, e);
				return {
					content: [{ type: "text", text: `Published ${e.kind} "${e.title}" to the board (${entries.length} cards total).` }],
					details: { boardUrl: `http://${HOST}:${PORT}` },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `board tool failed: ${(err as Error).message}` }],
					details: {},
				};
			}
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("board-settings", {
		description: "Teaching-board settings: bare = show, /board-settings <key> <value> = set (applies live)",
		handler: async (args, ctx) => {
			if (!boardActive || !configFile) {
				ctx.ui.notify(
					"board: inactive in this session — cwd not in teaching-board/config.json allowlist, or no session started yet",
					"error",
				);
				return;
			}
			refreshConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify(
					`board settings — ${CONFIG_KEYS.map((k) => `${k}=${JSON.stringify(config[k as keyof BoardConfig])}`).join("  ")}`,
					"info",
				);
				return;
			}
			if (parts.length !== 2) {
				ctx.ui.notify("usage: /board-settings [key value] — keys: " + CONFIG_KEYS.join(", "), "warning");
				return;
			}
			const [key, val] = parts;
			const next: BoardConfig = { ...config };
			let ok = true;
			switch (key) {
				case "theme":
					if (val === "dark" || val === "light") next.theme = val;
					else ok = false;
					break;
				case "accent":
					if (/^#[0-9a-fA-F]{6}$/.test(val)) next.accent = val;
					else ok = false;
					break;
				case "fontSize":
				case "mathScale": {
					const n = Number(val);
					const lo = key === "fontSize" ? 10 : 0.8;
					const hi = key === "fontSize" ? 24 : 2;
					if (Number.isFinite(n) && n >= lo && n <= hi) (next as Record<string, unknown>)[key] = n;
					else ok = false;
					break;
				}
				case "cardOrder":
					if (val === "oldest-first" || val === "newest-first") next.cardOrder = val;
					else ok = false;
					break;
				case "defaultFilter":
					if (val.trim()) next.defaultFilter = val.trim();
					else ok = false;
					break;
				case "maxCards": {
					const n = Number(val);
					if (Number.isInteger(n) && n >= 0) next.maxCards = n;
					else ok = false;
					break;
				}
				default:
					ctx.ui.notify(`board: unknown key "${key}" — keys: ${CONFIG_KEYS.join(", ")}`, "error");
					return;
			}
			if (!ok) {
				const ranges: Record<string, string> = {
					theme: "dark|light",
					accent: "#rrggbb",
					fontSize: "10–24",
					mathScale: "0.8–2",
					cardOrder: "oldest-first|newest-first",
					defaultFilter: "any course name or 'all'",
					maxCards: "integer ≥ 0",
				};
				ctx.ui.notify(`board: invalid value "${val}" for ${key} (allowed: ${ranges[key]})`, "error");
				return;
			}
			try {
				writeFileSync(configFile, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
				config = next;
				configMtimeMs = statSync(configFile).mtimeMs;
				ctx.ui.notify(`board: ${key} = ${val} (applies live in the browser)`, "info");
			} catch (err) {
				ctx.ui.notify(`board: failed to write config (${(err as Error).message})`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const { dirs: allowed, error: allowlistError } = loadAllowedDirectories();
		const sessionCwd = ctx.cwd ?? process.cwd();
		if (!allowed.some((dir) => isUnderOrAt(sessionCwd, dir))) {
			boardActive = false;
			if (allowlistError && ctx.hasUI) {
				ctx.ui.notify(`teaching-board: ${allowlistError} — board disabled`, "warning");
			}
			return;
		}
		boardActive = true;
		registerBoardTool(pi);
		const root = findWorkspaceRoot(sessionCwd);
		boardFile = join(root, "BOARD.json");
		const legacy = join(root, "BOARD.jsonl");
		if (!existsSync(boardFile) && existsSync(legacy)) {
			// one-time migration: JSONL → pretty JSON array (legacy file kept)
			try {
				entries = parseJsonl(readFileSync(legacy, "utf8"));
				saveBoard(boardFile);
			} catch {
				// migration failure falls through to a fresh load
			}
		}
		configFile = join(root, "BOARD.config.json");
		configMtimeMs = -1;
		refreshConfig();
		loadBoard(boardFile);
		if (!server) await startServer(ctx);
	});

	pi.on("session_shutdown", async () => {
		const s = server;
		server = undefined;
		s?.close();
	});
}

const HTML_PAGE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi · teaching board</title>
<!--CONFIG-->
<link rel="stylesheet" href="/assets/katex/katex.min.css">
<script src="/assets/marked/marked.min.js"></script>
<script src="/assets/katex/katex.min.js"></script>
<style>
  :root {
    --accent: #4a7ec2;
    --font-size: 15px;
    --math-scale: 1;
    --side-w: 236px;
  }
  [data-theme="dark"] {
    --bg: #0f1115; --side-bg: #0c0e12; --card-bg: #141821; --text: #d7dce3;
    --dim: #5b6673; --mid: #8b96a3; --border: #232830; --chip-on-bg: #16202e;
    --details-bg: #10141c; --heading: #dfe5ec; --empty: #5b6673;
  }
  [data-theme="light"] {
    --bg: #f6f7f9; --side-bg: #eceef2; --card-bg: #ffffff; --text: #24292f;
    --dim: #6a737d; --mid: #57606a; --border: #d8dde3; --chip-on-bg: #e2ecf7;
    --details-bg: #f2f4f7; --heading: #1f2328; --empty: #8b949e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg); color: var(--text);
    font: var(--font-size)/1.65 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  }
  #side {
    position: fixed; top: 0; left: 0; bottom: 0; width: var(--side-w);
    background: var(--side-bg); border-right: 1px solid var(--border);
    padding: 16px 14px; overflow-y: auto; z-index: 20;
  }
  #side .brand { font-size: 14px; color: var(--mid); margin-bottom: 18px; }
  #side .brand b { color: var(--text); font-weight: 600; }
  .side-label {
    font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--dim); margin: 14px 2px 6px;
  }
  .chip {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5px 10px; margin: 2px 0; border-radius: 8px;
    border: 1px solid transparent; color: var(--mid); cursor: pointer;
    user-select: none; font-size: 13px;
  }
  .chip:hover { border-color: var(--border); }
  .chip.on { border-color: var(--accent); color: var(--text); background: var(--chip-on-bg); }
  .chip .n { font-size: 11px; color: var(--dim); }
  main { margin-left: var(--side-w); padding: 18px 28px 80px; max-width: 1080px; }
  h2.day {
    position: sticky; top: 0; z-index: 10;
    margin: 22px 0 8px; padding: 6px 2px;
    font-size: 13px; font-weight: 600; letter-spacing: .03em;
    color: var(--dim); background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  h2.day:first-child { margin-top: 4px; }
  h2.day .n { font-weight: 400; }
  .card {
    margin: 14px 0; padding: 14px 16px 10px;
    background: var(--card-bg); border-radius: 10px; border-left: 3px solid #2e3440;
  }
  .card.note { border-left-color: var(--accent); }
  .card.theorem { border-left-color: #b08d57; }
  .card.question { border-left-color: #4e9e6b; }
  .card h3 { margin: 0 0 2px; font-size: 16px; color: var(--heading); }
  .meta { font-size: 12px; color: var(--dim); margin-bottom: 8px; }
  .badge {
    display: inline-block; padding: 1px 8px; margin-right: 8px;
    border-radius: 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em;
  }
  .note .badge { background: rgba(74,126,194,.18); color: #7fa4d4; }
  .theorem .badge { background: rgba(176,141,87,.16); color: #cfa96a; }
  .question .badge { background: rgba(78,158,107,.16); color: #78c093; }
  .card p { margin: .5em 0; }
  details {
    margin: 10px 0 4px; padding: 8px 12px;
    background: var(--details-bg); border: 1px solid var(--border); border-radius: 8px;
  }
  details summary { cursor: pointer; color: var(--mid); font-size: 13px; user-select: none; }
  details[open] summary { color: var(--text); }
  details .inner { margin-top: 6px; }
  pre code { font: 12.5px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; }
  .katex-display { overflow-x: auto; overflow-y: hidden; padding: 4px 0; margin: .8em 0; }
  .katex { font-size: calc(1.21em * var(--math-scale)); }
  .katex-error { color: #d0a17a; }
  .empty { color: var(--empty); text-align: center; margin-top: 40vh; }
  @media (max-width: 720px) {
    #side { position: static; width: auto; bottom: auto; border-right: none; border-bottom: 1px solid var(--border); }
    main { margin-left: 0; padding: 12px 14px 60px; }
  }
</style>
</head>
<body>
<aside id="side">
  <div class="brand"><b>pi</b> · teaching board</div>
  <div class="side-label">courses</div>
  <div id="chips"></div>
  <div class="side-label">time</div>
  <div id="times"></div>
</aside>
<main id="board"><div class="empty">loading…</div></main>
<script>
(function () {
  var lastVersion = -1, courseFilter = null, timeFilter = "all", cfg = null;
  var root = document.getElementById("board");
  var chipsEl = document.getElementById("chips");
  var timesEl = document.getElementById("times");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function splitCode(src) {
    var out = [], re = /(\`\`\`[\\s\\S]*?\`\`\`|\`[^\`\\n]+\`)/g, last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) out.push({ code: false, s: src.slice(last, m.index) });
      out.push({ code: true, s: m[0] });
      last = re.lastIndex;
    }
    if (last < src.length) out.push({ code: false, s: src.slice(last) });
    return out;
  }

  function splitMath(src) {
    var out = [], re = /\\$\\$([\\s\\S]+?)\\$\\$|\\$([^$\\n]+?)\\$/g, last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) out.push({ math: false, s: src.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ math: true, s: m[1], display: true });
      else out.push({ math: true, s: m[2], display: false });
      last = re.lastIndex;
    }
    if (last < src.length) out.push({ math: false, s: src.slice(last) });
    return out;
  }

  function rich(src) {
    var staged = "", store = [];
    var segs = splitCode(src);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].code) { staged += segs[i].s; continue; }
      var parts = splitMath(segs[i].s);
      for (var j = 0; j < parts.length; j++) {
        if (!parts[j].math) { staged += parts[j].s; continue; }
        var tok = "zkxmath" + store.length + "zkx";
        store.push({ tok: tok, src: parts[j].s, display: parts[j].display });
        staged += tok;
      }
    }
    var out = window.marked ? window.marked.parse(staged) : "<p>" + esc(staged) + "</p>";
    for (var k = 0; k < store.length; k++) {
      var e = store[k], html = null, raw = esc((e.display ? "$$" : "$") + e.src + (e.display ? "$$" : "$"));
      if (window.katex) {
        try { html = window.katex.renderToString(e.src, { displayMode: e.display, throwOnError: false }); }
        catch (err) { html = null; }
      }
      var ins = html !== null ? html : raw;
      if (e.display) {
        var reP = new RegExp("<p>\\\\s*" + e.tok + "\\\\s*</p>");
        out = out.replace(reP, ins);
      }
      out = out.split(e.tok).join(ins);
    }
    return out;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function dateKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  var WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function dayLabel(key) {
    var today = dateKey(Date.now());
    var yest = dateKey(Date.now() - 86400000);
    if (key === today) return "Today";
    if (key === yest) return "Yesterday";
    var p = key.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return WD[d.getDay()] + " " + +p[2] + " " + MO[+p[1] - 1] + " " + p[0];
  }
  function time(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function card(e) {
    var div = document.createElement("div");
    div.className = "card " + e.kind;
    var meta = '<span class="badge">' + e.kind + "</span>" +
      (e.course ? " · " + esc(e.course) : "") +
      (e.topic ? " · " + esc(e.topic) : "") +
      " · " + time(e.ts);
    var html = "<h3>" + esc(e.title) + "</h3>" +
      '<div class="meta">' + meta + "</div>" +
      '<div class="inner">' + rich(e.body) + "</div>";
    if (e.kind === "question") {
      if (e.hint) {
        html += "<details><summary>💡 hint</summary><div class=\\"inner\\">" + rich(e.hint) + "</div></details>";
      }
      if (e.solution) {
        html += "<details><summary>✅ solution — attempt first!</summary><div class=\\"inner\\">" + rich(e.solution) + "</div></details>";
      }
    }
    div.innerHTML = html;
    return div;
  }

  function courses(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].course || "";
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    }
    return out.sort();
  }
  function shortName(c) { return c.replace(/^math[0-9]+_/, ""); }

  function applyConfig(c) {
    var d = document.documentElement;
    d.dataset.theme = c.theme;
    var s = d.style;
    s.setProperty("--accent", c.accent);
    s.setProperty("--font-size", c.fontSize + "px");
    s.setProperty("--math-scale", c.mathScale);
  }

  function renderChips(all) {
    var cs = courses(all), html = "";
    if (courseFilter === null) courseFilter = (cfg && cfg.defaultFilter) || "all";
    html += chip("c", "all", "all", all.length);
    for (var i = 0; i < cs.length; i++) {
      var n = 0;
      for (var j = 0; j < all.length; j++) if (all[j].course === cs[i]) n++;
      html += chip("c", cs[i], shortName(cs[i]), n);
    }
    chipsEl.innerHTML = html;
    var tdefs = [["all","all time"],["today","today"],["7d","last 7 days"],["30d","last 30 days"]];
    var thtml = "";
    for (var t = 0; t < tdefs.length; t++) {
      var cnt = 0, lim = limitFor(tdefs[t][0]);
      for (var k = 0; k < all.length; k++) if (all[k].ts >= lim) cnt++;
      thtml += chip("t", tdefs[t][0], tdefs[t][1], tdefs[t][0] === "all" ? all.length : cnt);
    }
    timesEl.innerHTML = thtml;
  }
  function chip(dim, id, label, n) {
    var on = dim === "c" ? courseFilter === id : timeFilter === id;
    return '<div class="chip' + (on ? " on" : "") + '" data-dim="' + dim + '" data-c="' + esc(id) + '">' +
      "<span>" + esc(label) + '</span><span class="n">' + n + "</span></div>";
  }
  function limitFor(id) {
    var now = Date.now();
    if (id === "today") { var d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }
    if (id === "7d") return now - 7 * 86400000;
    if (id === "30d") return now - 30 * 86400000;
    return -Infinity;
  }

  function visible(all) {
    var lim = limitFor(timeFilter);
    var list = all.filter(function (e) {
      if (courseFilter !== "all" && e.course !== courseFilter) return false;
      return e.ts >= lim;
    });
    var newest = !cfg || cfg.cardOrder !== "oldest-first";
    list.sort(function (a, b) { return newest ? b.ts - a.ts : a.ts - b.ts; });
    if (cfg && cfg.maxCards > 0) list = list.slice(0, cfg.maxCards);
    return list;
  }

  function renderAll(data) {
    renderChips(data.entries);
    var list = visible(data.entries);
    root.innerHTML = "";
    if (!list.length) {
      root.innerHTML = '<div class="empty">no cards' +
        (courseFilter !== "all" || timeFilter !== "all" ? " for this filter" : " yet") + "…</div>";
      return;
    }
    var byKey = {}, order = [];
    for (var i = 0; i < list.length; i++) {
      var k = dateKey(list[i].ts);
      if (!byKey[k]) { byKey[k] = []; order.push(k); }
      byKey[k].push(list[i]);
    }
    for (var g = 0; g < order.length; g++) {
      var key = order[g], items = byKey[key];
      var h = document.createElement("h2");
      h.className = "day";
      h.innerHTML = dayLabel(key) + ' <span class="n">· ' + items.length +
        (items.length === 1 ? " card" : " cards") + "</span>";
      root.appendChild(h);
      for (var c = 0; c < items.length; c++) root.appendChild(card(items[c]));
    }
  }

  document.body.addEventListener("click", function (ev) {
    var t = ev.target;
    while (t && t !== document.body && !(t.classList && t.classList.contains("chip"))) t = t.parentElement;
    if (!t || !t.classList || !t.classList.contains("chip")) return;
    var dim = t.getAttribute("data-dim"), id = t.getAttribute("data-c");
    if (dim === "c") courseFilter = id; else timeFilter = id;
    lastVersion = -1;
    poll();
  });

  async function poll() {
    try {
      var r = await fetch("/board.json");
      var data = await r.json();
      if (data.config) {
        var changed = cfg && cfg.cardOrder !== data.config.cardOrder;
        applyConfig(data.config);
        cfg = data.config;
        if (changed) lastVersion = -1;
      }
      if (data.version !== lastVersion) {
        lastVersion = data.version;
        renderAll(data);
      }
    } catch (e) { /* server gone — retry quietly */ }
  }
  poll();
  setInterval(poll, 1500);
})();
</script>
</body>
</html>
`;
