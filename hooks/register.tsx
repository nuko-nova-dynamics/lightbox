// Lightbox: every image the session reads, receives or creates, in a small strip above the prompt, with a pane
// for a larger look on request. Images come from Read results, image blocks in tool results (screenshots), image
// files a tool call just wrote, images pasted into a prompt, the `show` tool Claude calls to send one, and
// `/lightbox <path>`.
//
// Pictures draw as real pixels (the Image element, kitty graphics) where Claude Code can, and otherwise as
// Unicode quadrant blocks in colored cells (the Raster element), which work in any terminal and over SSH.

import { atom, read, update } from "claude-code";
import type { ElementConstructor, EngineInterface, ImageProps, RasterProps, Register, RenderChildren } from "claude-code";
import type { LightboxShot } from "../types";
import { decodeBase64, quadrantCells, readBmp } from "./cells.ts";
import { absolutePath, ago, basename, CELL_ASPECT, decodedSize, fit, formatLabel, imageBlocks, imagePathsIn, imagesAfterText, isPng, quotedImagePaths, mimeForPath, pastedImagePaths, pngSize, toolLabel } from "./images.ts";

type Api = EngineInterface;
type Call = { readonly tool: string; readonly [field: string]: unknown };
type Bytes = { base64: string; mime: string };
type NewShot = { title: string; origin: string; mime: string; path?: string; caption?: string; originalWidth?: number; originalHeight?: number };
type Size = "strip" | "full";
type Row = { readonly message: { readonly type: string; readonly name?: string; readonly content: readonly unknown[] }; readonly origin: { readonly kind: string }; readonly agentId?: string };

const PANE = "lightbox";
const SHOW_TOOL = "mcp__lightbox__show";
const shots = atom({ plugin: "lightbox", key: "shots" } as const, [] as LightboxShot[]);
const current = atom({ plugin: "lightbox", key: "current" } as const, 0);
const hidden = atom({ plugin: "lightbox", key: "hidden" } as const, false);
const folded = atom({ plugin: "lightbox", key: "folded" } as const, false);

const REEL_SIZE = 24;
const PIXELS_KEPT = 12;
const CELLS_KEPT = 64;
// The Image element takes at most 2 MiB of PNG.
const PNG_LIMIT = 2 * 1024 * 1024 - 4096;
// And at most this many pixels on a side.
const PNG_SIDE_LIMIT = 4096;
// The strip's picture: a few rows tall, so a small PNG. Every redraw carries it, so it must stay small.
const STRIP_SIDE = 480;
// Rows of picture inside the strip's frame; the frame adds one above and one below.
const STRIP_ROWS = 4;
const STRIP_MAX_COLUMNS = 40;
// The pane's picture, prepared only once the pane asks for it.
const FULL_SIDE = 1280;
const SMALLER_SIDE = 800;
const THUMB_COLUMNS = 12;
const THUMB_ROWS = 4;
const FORMATS = "PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG";
// Who an image came from, at a glance: the person's in the accent color, Claude's in Claude's own orange.
const YOURS = "cyan";
const CLAUDES = "#D97757";
// Up to this many images the strip shows one dot each; past it, a count.
const DOTS = 12;
// Images from one sender this close together arrived together: several pasted at once, or sent at once.
const BATCH_MS = 3000;
// The most images one paste or one tool result puts on the reel.
const CAPTURE_MAX = 12;
// The most pictures of one batch the strip shows side by side.
const BATCH_SHOWN = 4;

// Prints, as base64, a PNG of the first frame of an image, no longer than $2 pixels on its longest side, and
// writes the original size to stderr as "dims W H". $1 is a file path, or "-" to read base64 from stdin; $3 is
// its MIME type. The image is decoded once: the size comes from the header. sips (macOS ImageIO) goes first for
// HEIC, which it decodes several times faster than ImageMagick; ImageMagick goes first for the rest (SVG among
// them), and JPEGs decode at reduced scale.
const CONVERT = [
  'umask 077; in="$1"; side="$2"; mime="$3"; tmp="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")" || exit 1',
  'trap \'rm -f "$tmp" "$tmp.in" "$tmp.png"\' EXIT',
  'if [ "$in" = "-" ]; then base64 -d > "$tmp.in" || exit 1; in="$tmp.in"; fi',
  'with_sips() {',
  '  command -v sips >/dev/null 2>&1 || return 1',
  '  sips -s format png -Z "$side" "$in" --out "$tmp.png" >/dev/null 2>&1; [ -s "$tmp.png" ] || return 1',
  '  dims="$(sips -g pixelWidth -g pixelHeight "$in" 2>/dev/null | awk \'/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{if(w)print w, h}\')"',
  // sips keeps an EXIF orientation as a tag rather than turning the pixels, which the terminal draws as they lie.
  '  if command -v magick >/dev/null 2>&1; then',
  '    case "$(magick identify -format "%[orientation]" "$tmp.png" 2>/dev/null)" in LeftTop|RightTop|RightBottom|LeftBottom) dims="$(echo "$dims" | awk \'{print $2, $1}\')" ;; esac',
  '    magick "$tmp.png" -auto-orient "$tmp.png" 2>/dev/null',
  '  fi',
  '  if [ -n "$dims" ]; then echo "dims $dims" >&2; fi',
  '}',
  'with_magick() {',
  '  if command -v magick >/dev/null 2>&1; then id="magick identify"; cv=magick; elif command -v convert >/dev/null 2>&1; then id=identify; cv=convert; else return 1; fi',
  '  $id -ping -format "dims %w %h\\n" "$in[0]" >&2 2>/dev/null',
  '  $cv -define jpeg:size=$((side * 2))x$((side * 2)) "$in[0]" -auto-orient -resize "${side}x${side}>" -depth 8 "png:$tmp.png" 2>/dev/null; [ -s "$tmp.png" ]',
  '}',
  'case "$mime" in image/heic|image/heif) with_sips || with_magick ;; *) with_magick || with_sips ;; esac',
  'if [ ! -s "$tmp.png" ]; then echo "no converter here could read this image (ImageMagick, or sips on macOS)" >&2; exit 1; fi',
  'base64 < "$tmp.png" | tr -d "\\n"'
].join("\n");

// Prints, as base64, an uncompressed BMP of a PNG (read from stdin as base64) resized to exactly $1 by $2 pixels:
// the pixels a Raster's quadrant cells are fitted to.
const TO_BMP = [
  'umask 077; w="$1"; h="$2"; tmp="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")" || exit 1',
  'trap \'rm -f "$tmp" "$tmp.png" "$tmp.bmp"\' EXIT',
  'base64 -d > "$tmp.png" || exit 1',
  'if command -v magick >/dev/null 2>&1; then magick "$tmp.png[0]" -background black -alpha remove -alpha off -resize "${w}x${h}!" bmp3:-',
  'elif command -v convert >/dev/null 2>&1; then convert "$tmp.png[0]" -background black -alpha remove -alpha off -resize "${w}x${h}!" bmp3:-',
  'elif command -v sips >/dev/null 2>&1; then sips -s format bmp -z "$h" "$w" "$tmp.png" --out "$tmp.bmp" >/dev/null && cat "$tmp.bmp"',
  'else echo "no image converter found: install ImageMagick" >&2; exit 127',
  'fi | base64 | tr -d "\\n"'
].join("\n");

// Pictures ready to draw, by shot id: the module's own memory, so a reload prepares them again.
const pixels = new Map<string, { strip?: string; full?: string }>();
// Image bytes that arrived with no file behind them, kept while the shot is among the recent few.
const inline = new Map<string, Bytes>();
const preparing = new Set<string>();
// Quadrant cells by shot and size; and the jobs computing them.
const cellCache = new Map<string, string>();
const cellJobs = new Set<string>();
let autoOpen = true;
let canOpen = false;
let rendererOption = "auto";
let drawsPixels = false;
let cellAspect = CELL_ASPECT;
// Drawing cells only because this shell lacks CLAUDE_CODE_FORCE_TERMINAL_IMAGES, inside a multiplexer within a
// terminal that draws pixels: said once, at the first image, since a fresh shell fixes it.
let pixelsHint = "";
// Where images that came with no file behind them get a private copy, so they can be drawn again after the mod
// reloads (an option changed) and opened in another app; set at session start.
let cacheDir = "";
const EXTENSION_BY_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg" };

/** Writes image bytes to a file only this user can read, and returns its path, or undefined when it cannot. */
async function keepCopy($: Api, id: string, bytes: Bytes): Promise<string | undefined> {
  if (!cacheDir) return undefined;
  const name = `${id}.${EXTENSION_BY_MIME[bytes.mime] ?? bytes.mime.replace(/^image\//, "").replace(/[^a-z0-9]/gi, "")}`;
  const run = await $.process.run(["sh", "-c", 'umask 077 && mkdir -p "$1" && base64 -d > "$1/$2"', "lightbox", cacheDir, name], { stdin: bytes.base64 }).catch(() => null);
  return run?.exitCode === 0 ? `${cacheDir}/${name}` : undefined;
}

// True until the first session start after this module loaded: its memory of pictures and bytes starts empty.
let freshModule = true;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 160) ?? "";
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

async function convert($: Api, input: string, stdin: string, side: number, mime: string): Promise<{ png: string; dims: { width: number; height: number } | null }> {
  const run = await $.process.run(["sh", "-c", CONVERT, "lightbox", input, String(side), mime], { stdin, timeoutMs: 30_000 });
  // Too large to come back whole: the caller tries a smaller size.
  if (run.isStdoutTruncated) return { png: "", dims: null };
  const png = run.stdout.replace(/\s+/g, "");
  if (!isPng(png)) throw new Error(run.stderr.trim().split("\n").filter((l) => !l.startsWith("dims ")).pop() || `the converter exited with ${run.exitCode}`);
  const m = run.stderr.match(/dims (\d+) (\d+)/);
  return { png, dims: m ? { width: Number(m[1]), height: Number(m[2]) } : null };
}

/**
 * Turns a shot's bytes or file into a PNG it can draw at one size, notes its original size, then marks it ready.
 * The strip's picture comes first; the pane's larger one only when the pane is opened.
 */
async function prepare($: Api, id: string, which: Size): Promise<void> {
  const job = `${id}:${which}`;
  if (pixels.get(id)?.[which] || preparing.has(job)) return;
  const shot = (await read($, shots)).find((s) => s.id === id);
  if (!shot) return;
  preparing.add(job);
  try {
    const bytes = inline.get(id);
    const input = bytes ? "-" : (shot.path ?? shot.copy);
    if (!input) throw new Error("its bytes are no longer in memory");
    const stdin = bytes?.base64 ?? "";
    const side = which === "strip" ? STRIP_SIDE : FULL_SIDE;
    let picture = "";
    let original = shot.originalWidth && shot.originalHeight ? { width: shot.originalWidth, height: shot.originalHeight } : null;
    if (bytes && isPng(bytes.base64)) {
      const size = pngSize(bytes.base64);
      original = original ?? size;
      // A PNG small enough for this size is drawn as it is.
      if (size && decodedSize(bytes.base64) <= PNG_LIMIT && Math.max(size.width, size.height) <= (which === "full" ? PNG_SIDE_LIMIT : side)) picture = bytes.base64;
    }
    if (!picture && !bytes && which === "full" && shot.mime === "image/png") {
      const file = await $.fs.read(input, { as: "bytes" }).catch(() => null);
      const size = file ? pngSize(file.base64) : null;
      if (file && size && decodedSize(file.base64) <= PNG_LIMIT && Math.max(size.width, size.height) <= PNG_SIDE_LIMIT) picture = file.base64;
    }
    if (!picture) {
      const converted = await convert($, input, stdin, side, shot.mime);
      picture = converted.png;
      original = original ?? converted.dims;
    }
    if (!picture || decodedSize(picture) > PNG_LIMIT) picture = (await convert($, input, stdin, SMALLER_SIDE, shot.mime)).png;
    if (!picture || decodedSize(picture) > PNG_LIMIT) throw new Error("the picture is too large to draw, even made smaller");
    const drawn = pngSize(picture);
    pixels.set(id, { ...pixels.get(id), [which]: picture });
    await update($, shots, (list) =>
      list.map((s) =>
        s.id === id
          ? { ...s, status: "ready" as const, ...(drawn ?? {}), ...(original ? { originalWidth: original.width, originalHeight: original.height } : {}) }
          : s
      )
    );
  } catch (err) {
    // Without the strip's picture there is nothing to show; without the pane's, the strip's stands in.
    if (which === "strip") await update($, shots, (list) => list.map((s) => (s.id === id ? { ...s, status: "failed" as const, note: message(err) } : s)));
    else $.ui.log(`lightbox: larger picture for ${shot.title}: ${message(err)}`, { to: "debug" });
  } finally {
    preparing.delete(job);
  }
}

/** Fits quadrant cells to a shot's strip picture at one size, then asks for a redraw. */
async function renderCells($: Api, id: string, columns: number, rows: number): Promise<void> {
  const key = `${id}:${columns}x${rows}`;
  if (cellCache.has(key) || cellJobs.has(key)) return;
  const picture = pixels.get(id)?.strip;
  if (!picture) return;
  cellJobs.add(key);
  try {
    const run = await $.process.run(["sh", "-c", TO_BMP, "lightbox", String(columns * 2), String(rows * 2)], { stdin: picture, timeoutMs: 15_000 });
    const bmp = readBmp(decodeBase64(run.stdout));
    if (!bmp) throw new Error(run.stderr.trim().split("\n").pop() || "could not read the picture's pixels");
    cellCache.set(key, quadrantCells(bmp, columns, rows));
    while (cellCache.size > CELLS_KEPT) cellCache.delete(cellCache.keys().next().value as string);
    $.ui.invalidate("ui.render");
  } catch (err) {
    $.ui.log(`lightbox: cells for ${id}: ${message(err)}`, { to: "debug" });
  } finally {
    cellJobs.delete(key);
  }
}

// Shots being put on the reel: their bytes are held before the reel lists them, so eviction leaves them be.
const adding = new Set<string>();
// The shot whose capture wrote the reel last, and its place there: the one the selection follows.
let newest = "";
let newestIndex = 0;

/**
 * Drops what shots that left the reel held. Every shot on it keeps its small strip picture, so it can still be
 * shown; past the recent few it lets go of its larger picture, and of its original bytes once the strip's is made.
 */
function evict(list: readonly LightboxShot[]): void {
  const onReel = new Set(list.map((s) => s.id));
  const recent = new Set(list.slice(-PIXELS_KEPT).map((s) => s.id));
  for (const [id, picture] of pixels) {
    if (adding.has(id)) continue;
    if (!onReel.has(id)) pixels.delete(id);
    else if (!recent.has(id) && picture.full) pixels.set(id, picture.strip ? { strip: picture.strip } : {});
  }
  for (const id of inline.keys()) {
    if (adding.has(id) || recent.has(id) || (onReel.has(id) && !pixels.get(id)?.strip)) continue;
    inline.delete(id);
  }
  for (const key of cellCache.keys()) if (!onReel.has(key.split(":")[0] ?? "")) cellCache.delete(key);
  for (const [id, path] of copies) {
    if (adding.has(id) || onReel.has(id)) continue;
    copies.delete(id);
    gone.push(path);
  }
}

// The private copies of shots on the reel, by id; and copies whose shots left it, to delete.
const copies = new Map<string, string>();
let gone: string[] = [];

/** Deletes the private copies whose shots left the reel: only files in this session's own copy folder. */
async function sweep($: Api): Promise<void> {
  const paths = gone.filter((path) => cacheDir && path.startsWith(`${cacheDir}/`));
  gone = [];
  if (paths.length) await $.process.run(["rm", "-f", "--", ...paths]).catch(() => null);
}

/** A new image shows the strip again, unfolded; with autoOpen off, a hidden strip stays hidden and a toast says so. */
async function announce($: Api, title: string): Promise<void> {
  await update($, folded, () => false);
  if (autoOpen) {
    await update($, hidden, () => false);
    return;
  }
  if (await read($, hidden)) $.ui.toast(`New image: ${title} · /lightbox to view`);
}

/** Puts an image on the reel, makes it the current one, and prepares it in the background. */
async function addShot($: Api, shot: NewShot, bytes?: Bytes, quiet = false): Promise<void> {
  const id = newId();
  adding.add(id);
  if (bytes) inline.set(id, bytes);
  const copy = bytes && !shot.path ? await keepCopy($, id, bytes) : undefined;
  if (copy) copies.set(id, copy);
  const entry: LightboxShot = {
    id,
    title: shot.title,
    origin: shot.origin,
    mime: shot.mime,
    at: Date.now(),
    status: "pending",
    ...(shot.path ? { path: shot.path } : {}),
    ...(copy ? { copy } : {}),
    ...(shot.caption ? { caption: shot.caption } : {}),
    ...(shot.originalWidth && shot.originalHeight ? { originalWidth: shot.originalWidth, originalHeight: shot.originalHeight } : {})
  };
  await update($, shots, (list) => {
    newest = id;
    // The same file again replaces its earlier shot, so an edited SVG or a retaken screenshot shows fresh.
    const rest = shot.path ? list.filter((s) => s.path !== shot.path) : list;
    const before = rest[rest.length - 1];
    if (before && before.origin === entry.origin && entry.at - before.at <= BATCH_MS) entry.batch = before.batch ?? before.id;
    const reel = [...rest, entry].slice(-REEL_SIZE);
    newestIndex = reel.length - 1;
    return reel;
  });
  // Evicts right on the read, with nothing awaited between, and only then stops protecting this shot: a capture
  // running beside this one may be about to evict from an older reel that does not list it yet.
  const list = await read($, shots);
  evict(list);
  adding.delete(id);
  await sweep($);
  // Only while it is still the newest, checked as the selection is written: a capture that finished later has
  // already moved it on.
  await update($, current, (i) => (newest === id ? newestIndex : (i ?? 0)));
  $.clock.after(0, () => { void prepare($, id, "strip"); });
  if (pixelsHint) {
    $.ui.toast(pixelsHint);
    pixelsHint = "";
  }
  if (!quiet) await announce($, shot.title);
}

/** Puts an image file on the reel, or says why it cannot. */
async function showFile($: Api, raw: string, origin: string, caption?: string, quiet = false): Promise<string> {
  const path = absolutePath(raw.trim(), await $.session.cwd(), (await $.env.get("HOME")) ?? "");
  const mime = mimeForPath(path);
  if (!mime) return `${basename(path)} is not an image the Lightbox shows (${FORMATS}).`;
  const stat = await $.fs.stat(path).catch(() => null);
  if (!stat || stat.kind !== "file") return `No image file at ${path}.`;
  await addShot($, { title: basename(path), origin, path, mime, ...(caption ? { caption } : {}) }, undefined, quiet);
  return `Showing ${basename(path)} in the Lightbox.`;
}

// Words that run another program, or only set up for one: never the program that wrote an image.
const WRAPPERS = new Set(["cd", "pushd", "env", "sudo", "timeout", "nice", "nohup", "time", "command", "exec", "xargs"]);

/** Who wrote an image file: for a shell command, the program in the part of it that names the file. */
function originOf(call: Call, path: string): string {
  if (call.tool === "Write" || call.tool === "Edit") return "written by Claude";
  if (call.tool !== "Bash") return `from ${toolLabel(call.tool)}`;
  const parts = String(call.command ?? "").split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean);
  const part = parts.find((p) => p.includes(basename(path))) ?? parts.find((p) => !/^(cd|pushd)\s/.test(p)) ?? "";
  const words = part.split(/\s+/);
  let i = 0;
  // Skip variable assignments, wrappers and their flags and durations (`timeout 60`, `nice -n 5`).
  while (i < words.length && (/^\w+=/.test(words[i]!) || WRAPPERS.has(words[i]!) || /^-/.test(words[i]!) || /^\d+[smhd]?$/.test(words[i]!))) i += 1;
  const program = words[i]?.replace(/^.*\//, "");
  return `from ${program || "a command"}`;
}

/** The directories a shell command changes into, in order: `cd dir` and `pushd dir`, quotes taken off. */
function cdTargets(command: string): string[] {
  return [...command.matchAll(/(?:^|[;&|(\n]\s*)(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map((m) => m[1]!.replace(/^["']|["']$/g, "")).filter((dir) => dir !== "-");
}

// Claude Code's scratch folder for a session: what Claude writes there is its own working material.
const SCRATCH = /\/claude-\d+\/[^/]+\/[^/]+\/scratchpad\//;

/** Finds the images a finished tool call read, returned or wrote, and puts them on the reel. */
async function capture($: Api, call: Call, result: unknown, started: number): Promise<void> {
  const r = (result ?? {}) as { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown };
  if (r.deny !== undefined || r.isError) return;

  if (call.tool === "Read") {
    const path = String(call.file_path ?? "");
    const value = r.result as { type?: string; file?: { base64?: string; type?: string; dimensions?: { originalWidth?: number; originalHeight?: number } } } | undefined;
    if (value?.type === "image" && value.file?.base64) {
      const mime = value.file.type ?? "image/png";
      const d = value.file.dimensions;
      await addShot(
        $,
        { title: basename(path), origin: "read by Claude", mime, ...(path ? { path } : {}), ...(d?.originalWidth && d.originalHeight ? { originalWidth: d.originalWidth, originalHeight: d.originalHeight } : {}) },
        { base64: value.file.base64, mime }
      );
    } else if (path && mimeForPath(path)) {
      // Formats Read does not decode itself, such as HEIC, go through the file.
      await showFile($, path, "read by Claude");
    }
    return;
  }

  const blocks = imageBlocks(r.result).slice(0, CAPTURE_MAX);
  for (const block of blocks) await addShot($, { title: toolLabel(call.tool), origin: `from ${toolLabel(call.tool)}`, mime: block.mime }, block);
  if (blocks.length) return;

  // Image files the call just wrote: named in its input or output, and modified while it ran. A call that ran
  // read-only (`ls`, `file`) wrote none, whatever it names.
  if ((result as { isReadOnly?: true } | undefined)?.isReadOnly) return;
  // A field that is one path is taken whole, spaces and all, and so is a quoted path in a command; the rest of the
  // text is searched for paths.
  const texts = [...Object.values(call).filter((v): v is string => typeof v === "string"), typeof r.text === "string" ? r.text : ""];
  const fields = texts.filter((v) => !v.includes("\n") && Boolean(mimeForPath(v)));
  const candidates = [...new Set([...fields, ...texts.flatMap(quotedImagePaths), ...imagePathsIn(`${JSON.stringify(call)}\n${texts.at(-1)}`)])].slice(0, 8);
  if (!candidates.length) return;
  const cwd = await $.session.cwd();
  const home = (await $.env.get("HOME")) ?? "";
  // A relative path in a command that changed directory first may be relative to where it went: the latest one
  // that holds the file wins.
  const bases = [cwd, ...(call.tool === "Bash" ? cdTargets(String(call.command ?? "")).map((dir) => absolutePath(dir, cwd, home)) : [])];
  for (const candidate of candidates) {
    let path = "";
    let stat = null;
    for (const base of candidate.startsWith("/") || candidate.startsWith("~/") ? [cwd] : [...bases].reverse()) {
      path = absolutePath(candidate, base, home);
      stat = await $.fs.stat(path).catch(() => null);
      if (stat) break;
    }
    if (!stat || stat.kind !== "file" || stat.size === 0 || stat.mtimeMs < started - 2000) continue;
    // A scratch file Claude wrote is not meant for the person; one it reads or sends still shows.
    if (SCRATCH.test(path)) continue;
    await addShot($, { title: basename(path), origin: originOf(call, path), path, mime: mimeForPath(path) });
  }
}

/**
 * A prompt queued while Claude worked keeps only its text in its own row; its images are in the conversation the
 * next request is built from, right after that text. The row is stored before the conversation shows it, so a
 * miss looks again a little later.
 */
async function queuedImages($: Api, text: string, labeled: boolean): Promise<Bytes[]> {
  // A prompt that names an image is looked up until it shows; one that names none, once.
  for (const wait of labeled ? [0, 250, 1000] : [0]) {
    if (wait) await new Promise<void>((resolve) => { $.clock.after(wait, () => resolve()); });
    const found = imagesAfterText(await $.session.messages({ as: "api" }), text);
    if (found.length) return found;
  }
  if (!labeled) return [];
  $.ui.log("lightbox: a queued prompt named an image the conversation does not hold", { to: "debug" });
  return [];
}

/**
 * Images the person put in a prompt: its row carries each as an image block, whether pasted from the clipboard
 * or dragged in as a file (which Claude Code also notes as `[Image: source: /path]`, naming it). A prompt typed
 * while Claude works arrives as a `queued_command` row instead, delivered into the running turn.
 */
async function capturePasted($: Api, row: Row): Promise<void> {
  const queued = row.message.type === "attachment" && row.message.name === "queued_command";
  if (row.agentId || (row.message.type !== "user" && !queued) || (row.origin.kind !== "composer" && row.origin.kind !== "bridge")) return;
  const texts = row.message.content.flatMap((b) => ((b as { type?: string }).type === "text" ? [String((b as { text?: unknown }).text ?? "")] : []));
  const text = texts.join("\n");
  // A queued prompt names its pasted images `[Image #N]` when they came from the clipboard; one from Remote Control
  // or with a dragged-in file may carry its images with no label, so then its text is looked up whole.
  const labeled = texts.find((t) => /\[Image #\d+\]/.test(t));
  const marked = labeled ?? texts.findLast((t) => t.trim());
  const blocks = (queued ? (marked ? await queuedImages($, marked, Boolean(labeled)) : []) : imageBlocks(row.message.content)).slice(0, CAPTURE_MAX);
  const paths = pastedImagePaths(text);
  // A message with no image means the person has moved on: the strip folds to one line until the next image.
  if (!blocks.length && !paths.length) {
    await update($, folded, () => true);
    return;
  }
  // The transcript shows each pasted image as `[Image #N]`; the strip names it the same, so the two match.
  const labels = [...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => `Image #${m[1]}`);
  const cwd = await $.session.cwd();
  const home = (await $.env.get("HOME")) ?? "";
  for (const [i, block] of blocks.entries()) {
    const path = paths[i] ? absolutePath(paths[i], cwd, home) : undefined;
    const title = labels[i] ?? (path ? basename(path) : blocks.length > 1 ? `Pasted image ${i + 1}` : "Pasted image");
    await addShot($, { title, origin: "pasted by you", mime: block.mime, ...(path ? { path } : {}) }, block);
  }
  // A file the model could not take as an image block (a HEIC, say) still shows, from the file.
  for (const path of paths.slice(blocks.length, CAPTURE_MAX)) await showFile($, path, "pasted by you");
}

async function removeShot($: Api, id: string): Promise<void> {
  let length = 0;
  await update($, shots, (list) => {
    const rest = list.filter((s) => s.id !== id);
    length = rest.length;
    return rest;
  });
  await update($, current, (i) => Math.max(0, Math.min(i ?? 0, length - 1)));
  pixels.delete(id);
  inline.delete(id);
  const copy = copies.get(id);
  if (copy) {
    copies.delete(id);
    gone.push(copy);
    await sweep($);
  }
}

async function openShot($: Api, shot: LightboxShot): Promise<void> {
  const file = shot.path ?? shot.copy;
  if (file) await $.process.run(["open", file]);
}

/**
 * Whether Claude Code draws real pixels here, unless the option says otherwise. Claude Code asks the terminal
 * and draws only for kitty or ghostty by name, so inside a multiplexer that renders kitty graphics (herdr names
 * itself libghostty) it needs CLAUDE_CODE_FORCE_TERMINAL_IMAGES; without it, a multiplexer means cells.
 */
async function choosePixels($: Api): Promise<boolean> {
  if (rendererOption === "pixels") return true;
  if (rendererOption === "cells") return false;
  // Claude Code reads the variable as on only for these values; 0, false or off leave pixels off.
  if (/^(1|true|yes|on)$/i.test(((await $.env.get("CLAUDE_CODE_FORCE_TERMINAL_IMAGES")) ?? "").trim())) return true;
  const term = (await $.env.get("TERM")) ?? "";
  const program = (await $.env.get("TERM_PROGRAM")) ?? "";
  const kitty = Boolean(await $.env.get("KITTY_WINDOW_ID"));
  const multiplexed = Boolean((await $.env.get("HERDR_ENV")) || (await $.env.get("TMUX")) || (await $.env.get("ZELLIJ")) || (await $.env.get("STY")));
  return !multiplexed && (/kitty|ghostty/i.test(term) || kitty || /^(ghostty|kitty)$/i.test(program));
}

const clampIndex = (i: number | undefined, length: number) => Math.max(0, Math.min(i ?? 0, length - 1));

/** When it arrived, its original size and its format. */
function details(shot: LightboxShot): string {
  const sizeLabel = shot.originalWidth && shot.originalHeight ? `${shot.originalWidth}×${shot.originalHeight}` : shot.width ? `${shot.width}×${shot.height}` : "";
  return [ago(Date.now() - shot.at), sizeLabel, formatLabel(shot.mime)].filter(Boolean).join(" · ");
}

const metaLine = (shot: LightboxShot) => `${shot.origin} · ${details(shot)}`;

function originColor(origin: string): string | undefined {
  if (/\byou$/.test(origin)) return YOURS;
  if (/\bClaude$/.test(origin)) return CLAUDES;
  return undefined;
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false;
  rendererOption = String(options.renderer ?? "auto");
  const aspect = Number(options.cellAspect);
  cellAspect = aspect >= 1 && aspect <= 4 ? aspect : CELL_ASPECT;
  // An explicit choice holds from the start; "auto" is settled at session start, from the terminal's environment.
  drawsPixels = rendererOption === "pixels";

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const system = await $.process.run(["uname", "-s"]).catch(() => null);
    const remote = (await $.env.get("SSH_CONNECTION")) || (await $.env.get("SSH_TTY"));
    // Opening a file in Preview or Finder only means something on the Mac the person is looking at.
    canOpen = system?.stdout.trim() === "Darwin" && !remote;
    drawsPixels = await choosePixels($);
    cacheDir = `${((await $.env.get("TMPDIR")) ?? "/tmp").replace(/\/$/, "")}/lightbox/${await $.session.id()}`;
    // After a reload the module holds no bytes: an image with neither a file nor a private copy cannot be drawn
    // again, so it leaves the reel.
    if (freshModule) {
      freshModule = false;
      const kept = await update($, shots, (list) => list.filter((s) => s.path || s.copy));
      for (const s of kept) if (s.copy) copies.set(s.id, s.copy);
      await update($, current, (i) => clampIndex(i, kept.length));
    }
    if (!drawsPixels && rendererOption === "auto" && (await $.env.get("HERDR_ENV")) && ((await $.env.get("GHOSTTY_RESOURCES_DIR")) || (await $.env.get("KITTY_WINDOW_ID")))) {
      pixelsHint = "Lightbox draws blocks here: this shell has no CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1. Set it, or open a new pane, and restart Claude for real pixels.";
      $.ui.log(`lightbox: ${pixelsHint}`, { to: "debug" });
    }
    // Keeps "2 min ago" true while the strip sits there.
    $.clock.every(60_000, () => $.ui.invalidate("ui.render"));
    if (!autoOpen && !(await read($, shots)).length) await update($, hidden, () => true);
    await $.tool.register({
      name: "show",
      description: `Show the user an image file in the Lightbox, the strip above their prompt. Use it whenever you want the user to see an image: a screenshot you took, an image you generated or edited, a diagram you rendered, or an image file you found. Accepts ${FORMATS}. Images you open with the Read tool, and images tools return, appear there by themselves.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The image file: an absolute path, ~/..., or a path relative to the working directory" },
          caption: { type: "string", description: "One short line shown beside the image" }
        },
        required: ["path"]
      }
    });
    try {
      await $.command.register({ name: "lightbox", description: "Show or hide the Lightbox strip above the prompt: the images you pasted and Claude read, received or created", argumentHint: "[image path | view | clear]", immediate: true });
    } catch (err) {
      $.ui.log(`lightbox: /lightbox not registered: ${message(err)}`, { to: "debug" });
    }
    return result;
  });

  // Images pasted into a prompt, typed at an idle prompt (door `prompt`) or queued while Claude works and
  // delivered into the running turn (door `delivery`). Captured once the row is stored, off the append's path,
  // so the prompt is not held up.
  for (const door of ["prompt", "delivery"] as const) {
    on("session.append", { door }, async ($, e, next) => {
      const result = await next(e);
      $.clock.after(0, () => {
        void capturePasted($, e as unknown as Row).catch((err) => $.ui.log(`lightbox: ${message(err)}`, { to: "debug" }));
      });
      return result;
    });
  }

  on("tool.call", async ($, e, next) => {
    const call = e as unknown as Call;
    if (call.tool === SHOW_TOOL) {
      // One line: the strip gives a caption one row.
      const caption = typeof call.caption === "string" ? call.caption.replace(/\s+/g, " ").trim().slice(0, 200) || undefined : undefined;
      return { result: await showFile($, String(call.path ?? ""), "sent by Claude", caption) };
    }
    const started = Date.now();
    const result = await next(e);
    try {
      await capture($, call, result, started);
    } catch (err) {
      $.ui.log(`lightbox: ${message(err)}`, { to: "debug" });
    }
    return result;
  });

  on("command.run", { command: "lightbox" }, async ($, e) => {
    const arg = String(e.args ?? "").trim();
    if (arg === "clear") {
      await update($, shots, () => []);
      await update($, current, () => 0);
      pixels.clear();
      inline.clear();
      cellCache.clear();
      gone.push(...copies.values());
      copies.clear();
      await sweep($);
      return { text: "Lightbox cleared." };
    }
    if (arg === "view") {
      await $.ui.open({ id: PANE, title: "Lightbox", focus: true });
      return {};
    }
    if (arg) {
      const said = await showFile($, arg, "opened by you", undefined, true);
      if (!said.startsWith("Showing")) return { text: said };
      await update($, hidden, () => false);
      await update($, folded, () => false);
      return {};
    }
    if (!(await read($, shots)).length) return { text: `No images yet. Pasted images, images Claude reads or sends, and /lightbox <path> (${FORMATS}) appear above the prompt.` };
    const open = !(await read($, hidden)) && !(await read($, folded));
    await update($, hidden, () => open);
    await update($, folded, () => false);
    return {};
  });

  on("ui.close", { id: PANE }, async ($, e, next) => {
    const result = await next(e);
    $.ui.invalidate("ui.render");
    return result;
  });

  // The strip above the prompt: the current image and the others that arrived with it, small, side by side,
  // with the current one's name, where it came from, and the keys.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e);
    const list = await read($, shots);
    if (!list.length) return next(e);
    // While the larger pane shows, the strip would only repeat it.
    if ((await $.ui.panes()).some((pane) => pane.id === PANE && pane.isShown)) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const elements = $.ui.resolve(e) as unknown as { Image?: ElementConstructor<ImageProps>; Raster?: ElementConstructor<RasterProps> };
    const Image = e.surface === "terminal" && drawsPixels ? elements.Image : undefined;
    const Raster = e.surface === "terminal" && !drawsPixels ? elements.Raster : undefined;

    const index = clampIndex(await read($, current), list.length);
    const shot = list[index]!;

    // The batch the current image arrived in, and the window of it that fits.
    const batchOf = (s: LightboxShot) => s.batch ?? s.id;
    let first = index;
    let last = index;
    while (first > 0 && batchOf(list[first - 1]!) === batchOf(shot)) first -= 1;
    while (last < list.length - 1 && batchOf(list[last + 1]!) === batchOf(shot)) last += 1;
    const from = Math.max(first, Math.min(index - Math.floor(BATCH_SHOWN / 2), last - BATCH_SHOWN + 1));
    const shown = list.slice(from, Math.min(last + 1, from + BATCH_SHOWN));
    const before = from - first;
    const after = last + 1 - (from + shown.length);

    // The band gets the rows the bottom slot has left above the prompt, fewer while a list of running agents
    // sits there too, and scrolls whatever is taller. The strip always fits them whole instead: smaller pictures
    // first, then fewer words and keys, then a single line.
    const rows = e.props.maxRows;
    const maxRows = Math.max(1, Math.min(STRIP_ROWS, rows - 2));
    // The pictures share about three fifths of the width, each in its frame; the words take the rest.
    const budget = Math.floor(e.props.bodyColumns * 0.6) - (shown.length - 1);
    const each = Math.max(6, Math.min(STRIP_MAX_COLUMNS, Math.floor(budget / shown.length) - 2));
    const boxOf = (s: LightboxShot) => (s.width && s.height ? fit(s.width, s.height, each, maxRows, cellAspect) : { columns: Math.min(each, Math.round(3 * cellAspect)), rows: Math.min(3, maxRows) });
    const counter = (n: number) => (n > 0 ? String(n).length + 2 : 0);
    const picturesWidth = shown.reduce((sum, s) => sum + boxOf(s).columns + 2, 0) + (shown.length - 1) + counter(before) + counter(after);
    // The words' column: the band less its padding, the pictures, the gap and the room kept for the collapse mark.
    const wordsWidth = e.props.bodyColumns - 2 - picturesWidth - 2 - 4;
    const cramped = rows < 4 || wordsWidth < 16;

    const frame = (s: LightboxShot) => {
      const strip = pixels.get(s.id)?.strip;
      if (!strip && s.status !== "failed") $.clock.after(0, () => { void prepare($, s.id, "strip"); });
      const box = boxOf(s);
      let view;
      if (s.status === "failed") view = <Text color="red">✕</Text>;
      else if (strip && Image) view = <Image key={`s-${s.id}`} source={{ png: strip }} columns={box.columns} rows={box.rows} alt={`${s.title} (image)`} />;
      else if (strip && Raster) {
        const cells = cellCache.get(`${s.id}:${box.columns}x${box.rows}`);
        if (!cells) $.clock.after(0, () => { void renderCells($, s.id, box.columns, box.rows); });
        view = cells ? <Raster key={`s-${s.id}`} columns={box.columns} rows={box.rows} cells={cells} /> : <Text dimColor>…</Text>;
      } else view = <Text dimColor>…</Text>;
      // The frame keeps a dark picture from melting into a dark terminal, in the color of who sent it; in a batch,
      // only the current one's frame is lit.
      const lit = s.id === shot.id && shown.length > 1;
      const color = s.id === shot.id ? (originColor(s.origin) ?? "gray") : "gray";
      return (
        <Box key={`f-${s.id}`} borderStyle="round" borderColor={color} borderDimColor={!lit} width={box.columns + 2} height={box.rows + 2} flexShrink={0}>
          {view}
        </Box>
      );
    };

    const step = (delta: number) => () => { void update($, current, (i) => ((((i ?? 0) + delta) % list.length) + list.length) % list.length); };
    const openPane = () => { void $.ui.open({ id: PANE, title: "Lightbox", focus: true }).then(() => $.ui.invalidate("ui.render")); };
    const tint = originColor(shot.origin);
    const count = last + 1 - first;

    // Folded: one line, its pictures a row tall, until the next image or the person opens it. Also where the band
    // has no room for more, and then the larger pane is the way to see it.
    const isFolded = await read($, folded);
    if (isFolded || cramped) {
      const tiny = (s: LightboxShot) => {
        const strip = pixels.get(s.id)?.strip;
        if (!strip && s.status !== "failed") $.clock.after(0, () => { void prepare($, s.id, "strip"); });
        if (!strip || !s.width || !s.height) return null;
        const size = fit(s.width, s.height, 8, 1, cellAspect);
        if (Image) return <Image key={`t-${s.id}`} source={{ png: strip }} columns={size.columns} rows={1} alt={s.title} />;
        if (!Raster) return null;
        const cells = cellCache.get(`${s.id}:${size.columns}x1`);
        if (!cells) $.clock.after(0, () => { void renderCells($, s.id, size.columns, 1); });
        return cells ? <Raster key={`t-${s.id}`} columns={size.columns} rows={1} cells={cells} /> : null;
      };
      // The keys and a dozen cells of name come first; tiny pictures fill what is left, none on a narrow band.
      const keysWidth = (isFolded ? "expand".length : "larger".length) + 1 + "hide".length;
      let room = e.props.bodyColumns - 2 - 4 - keysWidth - 1 - 12;
      const fitting = shown.filter((s) => {
        const width = s.width && s.height ? fit(s.width, s.height, 8, 1, cellAspect).columns + 1 : 0;
        if (width > room) { room = 0; return false; }
        room -= width;
        return true;
      });
      return (
        <Box flexDirection="row" paddingX={1} paddingRight={4} columnGap={1}>
          {fitting.map(tiny)}
          <Text bold wrap="truncate-middle">{shot.title}</Text>
          {count > 1 ? <Text dimColor wrap="truncate-end">+{count - 1}</Text> : null}
          {tint ? <Text color={tint} wrap="truncate-end">{shot.origin}</Text> : <Text dimColor wrap="truncate-end">{shot.origin}</Text>}
          <Text dimColor wrap="truncate-end">· {ago(Date.now() - shot.at)}</Text>
          <Box flexGrow={1} />
          {isFolded ? <Button key="expand" plain dimColor label="expand" onPress={() => { void update($, folded, () => false); }} /> : null}
          {isFolded ? null : <Button key="view" plain dimColor label="larger" onPress={openPane} />}
          <Button key="hide" plain dimColor label="hide" onPress={() => { void update($, hidden, () => true); }} />
        </Box>
      );
    }

    // The reel at a glance: a dot per image in its sender's color, the current one filled, batches apart.
    const reel =
      list.length > DOTS ? (
        <Text dimColor>{index + 1}/{list.length}</Text>
      ) : list.length > 1 ? (
        <Box flexDirection="row">
          {list.map((s, i) => {
            const color = originColor(s.origin);
            const dot = `${i > 0 && batchOf(list[i - 1]!) !== batchOf(s) ? " " : ""}${i === index ? "●" : "○"}`;
            return color ? <Text key={`d-${s.id}`} color={color} dimColor={i !== index}>{dot}</Text> : <Text key={`d-${s.id}`} dimColor>{dot}</Text>;
          })}
        </Box>
      ) : null;

    // The words' rows: a row above them, level with the picture's top, only when the band has rows to spare; then
    // the name and the details, a note when there is room, and the keys in what is left, the least needed dropped
    // first so they fit without wrapping past it.
    const lead = rows >= 6 ? 1 : 0;
    const spare = rows - lead - 2;
    const noteText = shot.status === "failed" ? `Can't show it: ${shot.note ?? "unknown error"}` : shot.caption;
    const note = noteText && spare >= 2 ? noteText : undefined;
    const keyRows = spare - (note ? 1 : 0);
    type Key = { id: string; width: number; node: RenderChildren };
    // Click targets: the label alone, dim until the pointer is over it.
    const button = (id: string, label: string, onPress: () => void): Key => ({ id, width: label.length, node: <Button key={id} plain dimColor label={label} onPress={onPress} /> });
    let keys: Key[] = [
      ...(list.length > 1 ? [button("prev", "‹ prev", step(-1)), button("next", "next ›", step(1))] : []),
      button("view", "larger", openPane),
      ...(canOpen && (shot.path || shot.copy) ? [button("open", "open", () => { void openShot($, shot); })] : []),
      button("fold", "fold", () => { void update($, folded, () => true); }),
      button("hide", "hide", () => { void update($, hidden, () => true); })
    ];
    const rowsFor = (items: Key[]) => {
      let lines = 1;
      let used = -2;
      for (const item of items) {
        if (used + 2 + item.width > wordsWidth && used >= 0) { lines += 1; used = -2; }
        used += 2 + item.width;
      }
      return lines;
    };
    for (const drop of ["fold", "open", "prev", "next", "view"]) {
      if (rowsFor(keys) <= keyRows) break;
      keys = keys.filter((k) => k.id !== drop);
    }

    return (
      <Box flexDirection="row" paddingX={1} columnGap={2}>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          {before > 0 ? <Box paddingTop={1}><Text dimColor>+{before}</Text></Box> : null}
          {shown.map(frame)}
          {after > 0 ? <Box paddingTop={1}><Text dimColor>+{after}</Text></Box> : null}
        </Box>
        {/* Level with the picture's top, and clear of the collapse mark in the band's top right corner. */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingTop={lead} paddingRight={4}>
          <Box flexDirection="row" columnGap={2} height={1}>
            <Text bold wrap="truncate-middle">{shot.title}</Text>
            {reel}
          </Box>
          <Box flexDirection="row" height={1}>
            <Text wrap="truncate-end">
              {tint ? <Text color={tint}>{shot.origin}</Text> : <Text dimColor>{shot.origin}</Text>}
              <Text dimColor> · {details(shot)}</Text>
            </Text>
          </Box>
          {note ? (shot.status === "failed" ? <Text color="red" wrap="truncate-end">{note}</Text> : <Text italic wrap="truncate-end">{note}</Text>) : null}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {keys.map((k) => k.node)}
          </Box>
        </Box>
      </Box>
    );
  });

  // The pane, opened from the strip or `/lightbox view`: the current image as large as the pane allows.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const elements = $.ui.resolve(e) as unknown as { Image?: ElementConstructor<ImageProps>; Raster?: ElementConstructor<RasterProps> };
    const Image = e.surface === "terminal" && drawsPixels ? elements.Image : undefined;
    const Raster = e.surface === "terminal" && !drawsPixels ? elements.Raster : undefined;
    const list = await read($, shots);
    const width = Math.max(10, e.props.bodyColumns - 2);

    if (!list.length) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <Text bold>Lightbox</Text>
          <Text dimColor>Images from this session appear here: whatever Claude reads, captures, generates or sends you, and what you paste.</Text>
          <Text dimColor>/lightbox ~/Pictures/photo.heic opens any {FORMATS} file.</Text>
        </Box>
      );
    }

    const index = clampIndex(await read($, current), list.length);
    const shot = list[index]!;
    const picture = pixels.get(shot.id);
    if (!picture?.strip && shot.status !== "failed") $.clock.after(0, () => { void prepare($, shot.id, "strip"); });
    // Real pixels want the larger picture; until it is ready the strip's stands in. Cells need no more than the strip's.
    if (Image && picture?.strip && !picture.full) $.clock.after(0, () => { void prepare($, shot.id, "full"); });

    const viewportRows = e.viewport?.rows ?? 40;
    // A docked pane is shorter than the screen (the prompt and status sit below it): size to its body.
    const bodyRows = e.props.scroll?.bodyRows ?? 0;
    const hasStrip = list.length > 1;
    const chrome = 2 + 2 + (shot.caption ? 2 : 0) + (hasStrip ? THUMB_ROWS + 3 : 0) + 3;
    const maxRows =
      e.props.placement === "dock"
        ? Math.max(6, (bodyRows > 0 ? bodyRows : viewportRows - 4) - chrome)
        : Math.max(6, Math.min(20, Math.floor(viewportRows * 0.5)));
    const box = shot.width && shot.height ? fit(shot.width, shot.height, width, maxRows, cellAspect) : null;

    let view;
    const source = picture?.full ?? picture?.strip;
    if (shot.status === "failed") {
      view = <Text color="red">Can't show this image: {shot.note ?? "unknown error"}</Text>;
    } else if (source && box && Image) {
      view = <Image key="main" source={{ png: source }} columns={box.columns} rows={box.rows} alt={`${shot.title} (image)`} />;
    } else if (source && box && Raster) {
      const cells = cellCache.get(`${shot.id}:${box.columns}x${box.rows}`);
      if (!cells) $.clock.after(0, () => { void renderCells($, shot.id, box.columns, box.rows); });
      view = cells ? <Raster key="main" columns={box.columns} rows={box.rows} cells={cells} /> : <Text dimColor>Drawing {shot.title}…</Text>;
    } else if (source && !Image && !Raster) {
      view = <Text dimColor>This surface does not draw images. Open it instead.</Text>;
    } else {
      view = <Text dimColor>Preparing {shot.title}…</Text>;
    }

    const slots = Math.max(1, Math.min(5, Math.floor((width + 1) / (THUMB_COLUMNS + 3))));
    const first = Math.max(0, Math.min(index - Math.floor(slots / 2), list.length - slots));
    const strip = list.slice(first, first + slots);
    const step = (delta: number) => () => { void update($, current, (i) => ((((i ?? 0) + delta) % list.length) + list.length) % list.length); };

    const thumbnail = (s: LightboxShot) => {
      const thumb = pixels.get(s.id)?.strip;
      if (!thumb && s.status !== "failed") $.clock.after(0, () => { void prepare($, s.id, "strip"); });
      if (!thumb || !s.width || !s.height) return <Text dimColor>…</Text>;
      const size = fit(s.width, s.height, THUMB_COLUMNS, THUMB_ROWS, cellAspect);
      if (Image) return <Image key={`i-${s.id}`} source={{ png: thumb }} columns={size.columns} rows={size.rows} alt={s.title} />;
      if (!Raster) return <Text dimColor wrap="truncate-end">{s.title}</Text>;
      const cells = cellCache.get(`${s.id}:${size.columns}x${size.rows}`);
      if (!cells) $.clock.after(0, () => { void renderCells($, s.id, size.columns, size.rows); });
      return cells ? <Raster key={`r-${s.id}`} columns={size.columns} rows={size.rows} cells={cells} /> : <Text dimColor>…</Text>;
    };

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Clear of the close mark Claude Code draws in the pane's top right corner. */}
        <Box flexDirection="row" justifyContent="space-between" paddingRight={2}>
          <Text bold wrap="truncate-middle">{shot.title}</Text>
          <Text dimColor>{index + 1} of {list.length}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{metaLine(shot)}</Text>
        <Box flexDirection="row" justifyContent="center" marginTop={1}>
          {view}
        </Box>
        {shot.caption ? <Box marginTop={1}><Text italic>{shot.caption}</Text></Box> : null}
        {hasStrip ? (
          <Box flexDirection="row" justifyContent="center" gap={1} marginTop={1}>
            {strip.map((s) => (
              <Box
                key={`t-${s.id}`}
                borderStyle="single"
                borderColor={s.id === shot.id ? "cyan" : "gray"}
                borderDimColor={s.id !== shot.id}
                width={THUMB_COLUMNS + 2}
                height={THUMB_ROWS + 2}
                justifyContent="center"
                alignItems="center"
              >
                {thumbnail(s)}
              </Box>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>{"─".repeat(width)}</Text>
        </Box>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          {list.length > 1 ? <Button key="prev" plain dimColor label="‹ prev" onPress={step(-1)} /> : null}
          {list.length > 1 ? <Button key="next" plain dimColor label="next ›" onPress={step(1)} /> : null}
          {canOpen && (shot.path || shot.copy) ? <Button key="open" plain dimColor label="open" onPress={() => { void openShot($, shot); }} /> : null}
          {canOpen && shot.path ? <Button key="reveal" plain dimColor label="show in Finder" onPress={() => { void $.process.run(["open", "-R", shot.path!]); }} /> : null}
          {shot.path ? <Button key="copy" plain dimColor label="copy path" onPress={() => { void $.ui.copy({ text: shot.path!, surface: e.surface }); }} /> : null}
          <Button key="remove" plain dimColor label="remove" onPress={() => { void removeShot($, shot.id); }} />
        </Box>
      </Box>
    );
  });
};
