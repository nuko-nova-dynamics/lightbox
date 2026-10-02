// Lightbox: every image the session reads, receives or creates, drawn in a pane beside the conversation.
// Images come from Read results, image blocks in tool results (screenshots), image files a tool call
// just wrote, images pasted into a prompt, the `show` tool Claude calls to send one, and `/lightbox <path>`.
//
// Pictures draw as real pixels (the Image element, kitty graphics) where Claude Code can, and otherwise as
// Unicode quadrant blocks in colored cells (the Raster element), which work in any terminal and over SSH.

import { atom, read, update } from "claude-code";
import type { ElementConstructor, EngineInterface, ImageProps, RasterProps, Register } from "claude-code";
import type { LightboxShot } from "../types";
import { decodeBase64, quadrantCells, readBmp } from "./cells.ts";
import { absolutePath, ago, basename, decodedSize, fit, formatLabel, imageBlocks, imagePathsIn, isPng, mimeForPath, pastedImagePaths, pngSize, toolLabel } from "./images.ts";

type Api = EngineInterface;
type Call = { readonly tool: string; readonly [field: string]: unknown };
type Bytes = { base64: string; mime: string };
type NewShot = { title: string; origin: string; mime: string; path?: string; caption?: string; originalWidth?: number; originalHeight?: number };

const PANE = "lightbox";
const SHOW_TOOL = "mcp__lightbox__show";
const shots = atom({ plugin: "lightbox", key: "shots" } as const, [] as LightboxShot[]);
const current = atom({ plugin: "lightbox", key: "current" } as const, 0);
const waiting = atom({ plugin: "lightbox", key: "waiting" } as const, false);

const REEL_SIZE = 24;
const PIXELS_KEPT = 12;
const CELLS_KEPT = 64;
// The Image element takes at most 2 MiB of PNG.
const PNG_LIMIT = 2 * 1024 * 1024 - 4096;
const FULL_SIDE = 1280;
const SMALLER_SIDE = 800;
const THUMB_SIDE = 256;
const THUMB_COLUMNS = 12;
const THUMB_ROWS = 4;
const FORMATS = "PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG";

// Prints, as base64, a PNG of the first frame of an image, no longer than $2 pixels on its longest side, and
// writes the original size to stderr as "dims W H". $1 is a file path, or "-" to read base64 from stdin.
// ImageMagick reads the most formats (SVG among them); when it decodes nothing, sips (macOS ImageIO) reads
// what Apple's own formats need, such as HEIC files ImageMagick's delegate rejects.
const CONVERT = [
  'in="$1"; side="$2"; tmp="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")" || exit 1',
  'trap \'rm -f "$tmp" "$tmp.in" "$tmp.png"\' EXIT',
  'if [ "$in" = "-" ]; then base64 -d > "$tmp.in" || exit 1; in="$tmp.in"; fi',
  'if command -v magick >/dev/null 2>&1; then magick identify -format "dims %w %h\\n" "$in[0]" >&2 2>/dev/null; magick "$in[0]" -auto-orient -resize "${side}x${side}>" "png:$tmp.png" 2>/dev/null',
  'elif command -v convert >/dev/null 2>&1; then identify -format "dims %w %h\\n" "$in[0]" >&2 2>/dev/null; convert "$in[0]" -auto-orient -resize "${side}x${side}>" "png:$tmp.png" 2>/dev/null; fi',
  'if [ ! -s "$tmp.png" ] && command -v sips >/dev/null 2>&1; then',
  '  sips -g pixelWidth -g pixelHeight "$in" 2>/dev/null | awk \'/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{if(w)print "dims", w, h}\' >&2',
  '  sips -s format png -Z "$side" "$in" --out "$tmp.png" >/dev/null 2>&1',
  'fi',
  'if [ ! -s "$tmp.png" ]; then echo "no converter here could read this image (ImageMagick, or sips on macOS)" >&2; exit 1; fi',
  'base64 < "$tmp.png" | tr -d "\\n"'
].join("\n");

// Prints, as base64, an uncompressed BMP of a PNG (read from stdin as base64) resized to exactly $1 by $2 pixels:
// the pixels a Raster's quadrant cells are fitted to.
const TO_BMP = [
  'w="$1"; h="$2"; tmp="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")" || exit 1',
  'trap \'rm -f "$tmp" "$tmp.png" "$tmp.bmp"\' EXIT',
  'base64 -d > "$tmp.png" || exit 1',
  'if command -v magick >/dev/null 2>&1; then magick "$tmp.png[0]" -background black -alpha remove -alpha off -resize "${w}x${h}!" bmp3:-',
  'elif command -v convert >/dev/null 2>&1; then convert "$tmp.png[0]" -background black -alpha remove -alpha off -resize "${w}x${h}!" bmp3:-',
  'elif command -v sips >/dev/null 2>&1; then sips -s format bmp -z "$h" "$w" "$tmp.png" --out "$tmp.bmp" >/dev/null && cat "$tmp.bmp"',
  'else echo "no image converter found: install ImageMagick" >&2; exit 127',
  'fi | base64 | tr -d "\\n"'
].join("\n");

// Pictures ready to draw, by shot id: the module's own memory, so a reload prepares them again.
const pixels = new Map<string, { full: string; thumb: string }>();
// Image bytes that arrived with no file behind them, kept until they are prepared.
const inline = new Map<string, Bytes>();
const preparing = new Set<string>();
// Quadrant cells by shot, picture and size; and the jobs computing them.
const cellCache = new Map<string, string>();
const cellJobs = new Set<string>();
let autoOpen = true;
let canOpen = false;
let rendererOption = "auto";
let drawsPixels = false;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 160) ?? "";
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

async function convert($: Api, input: string, stdin: string, side: number): Promise<{ png: string; dims: { width: number; height: number } | null }> {
  const run = await $.process.run(["sh", "-c", CONVERT, "lightbox", input, String(side)], { stdin, timeoutMs: 30_000 });
  const png = run.stdout.replace(/\s+/g, "");
  if (!isPng(png)) throw new Error(run.stderr.trim().split("\n").filter((l) => !l.startsWith("dims ")).pop() || `the converter exited with ${run.exitCode}`);
  const m = run.stderr.match(/dims (\d+) (\d+)/);
  return { png, dims: m ? { width: Number(m[1]), height: Number(m[2]) } : null };
}

/** Turns a shot's bytes or file into PNGs it can draw, notes its original size, then marks it ready. */
async function prepare($: Api, id: string): Promise<void> {
  if (pixels.has(id) || preparing.has(id)) return;
  const shot = (await read($, shots)).find((s) => s.id === id);
  if (!shot) return;
  preparing.add(id);
  try {
    const bytes = inline.get(id);
    const input = bytes ? "-" : shot.path;
    if (!input) throw new Error("its bytes are no longer in memory");
    const stdin = bytes?.base64 ?? "";
    let full = "";
    let original = shot.originalWidth && shot.originalHeight ? { width: shot.originalWidth, height: shot.originalHeight } : null;
    if (bytes && isPng(bytes.base64) && decodedSize(bytes.base64) <= PNG_LIMIT) full = bytes.base64;
    if (!bytes && shot.mime === "image/png") {
      const file = await $.fs.read(input, { as: "bytes" }).catch(() => null);
      if (file && decodedSize(file.base64) <= PNG_LIMIT) full = file.base64;
    }
    if (full) original = original ?? pngSize(full);
    else {
      const converted = await convert($, input, stdin, FULL_SIDE);
      full = converted.png;
      original = original ?? converted.dims;
    }
    if (decodedSize(full) > PNG_LIMIT) full = (await convert($, input, stdin, SMALLER_SIDE)).png;
    const thumb = decodedSize(full) <= 150_000 ? full : (await convert($, input, stdin, THUMB_SIDE)).png;
    const size = pngSize(full);
    pixels.set(id, { full, thumb });
    inline.delete(id);
    await update($, shots, (list) =>
      list.map((s) =>
        s.id === id
          ? { ...s, status: "ready" as const, ...(size ?? {}), ...(original ? { originalWidth: original.width, originalHeight: original.height } : {}) }
          : s
      )
    );
  } catch (err) {
    await update($, shots, (list) => list.map((s) => (s.id === id ? { ...s, status: "failed" as const, note: message(err) } : s)));
  } finally {
    preparing.delete(id);
  }
}

/** Fits quadrant cells to a prepared picture at one size, then asks for a redraw. */
async function renderCells($: Api, id: string, which: "full" | "thumb", columns: number, rows: number): Promise<void> {
  const key = `${id}:${which}:${columns}x${rows}`;
  if (cellCache.has(key) || cellJobs.has(key)) return;
  const picture = pixels.get(id);
  if (!picture) return;
  cellJobs.add(key);
  try {
    const run = await $.process.run(["sh", "-c", TO_BMP, "lightbox", String(columns * 2), String(rows * 2)], { stdin: picture[which], timeoutMs: 15_000 });
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

/** Drops pictures and bytes for shots that left the reel or fell out of the recent few. */
function evict(list: readonly LightboxShot[]): void {
  const recent = new Set(list.slice(-PIXELS_KEPT).map((s) => s.id));
  const onReel = new Set(list.map((s) => s.id));
  for (const id of pixels.keys()) if (!recent.has(id)) pixels.delete(id);
  for (const id of inline.keys()) if (!onReel.has(id)) inline.delete(id);
  for (const key of cellCache.keys()) if (!recent.has(key.split(":")[0] ?? "")) cellCache.delete(key);
}

async function announce($: Api, title: string): Promise<void> {
  if (autoOpen) {
    const opened = await $.ui.open({ id: PANE, title: "Lightbox" });
    if (opened.isPlaced) return;
    // Too narrow to seat a pane unasked: the band above the prompt says an image is waiting.
    await update($, waiting, () => true);
    return;
  }
  $.ui.toast(`New image: ${title} · /lightbox to view`);
}

/** Puts an image on the reel, makes it the current one, and prepares it in the background. */
async function addShot($: Api, shot: NewShot, bytes?: Bytes, quiet = false): Promise<void> {
  const id = newId();
  if (bytes) inline.set(id, bytes);
  const entry: LightboxShot = {
    id,
    title: shot.title,
    origin: shot.origin,
    mime: shot.mime,
    at: Date.now(),
    status: "pending",
    ...(shot.path ? { path: shot.path } : {}),
    ...(shot.caption ? { caption: shot.caption } : {}),
    ...(shot.originalWidth && shot.originalHeight ? { originalWidth: shot.originalWidth, originalHeight: shot.originalHeight } : {})
  };
  let reel: LightboxShot[] = [];
  await update($, shots, (list) => {
    // The same file again replaces its earlier shot, so an edited SVG or a retaken screenshot shows fresh.
    const rest = shot.path ? list.filter((s) => s.path !== shot.path) : list;
    reel = [...rest, entry].slice(-REEL_SIZE);
    return reel;
  });
  await update($, current, () => reel.length - 1);
  evict(reel);
  $.clock.after(0, () => { void prepare($, id); });
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
  return `Showing ${basename(path)} in the Lightbox pane.`;
}

function originOf(call: Call): string {
  if (call.tool === "Bash") return `from ${String(call.command ?? "").trim().split(/\s+/)[0]?.replace(/^.*\//, "") || "a command"}`;
  if (call.tool === "Write" || call.tool === "Edit") return "written by Claude";
  return `from ${toolLabel(call.tool)}`;
}

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

  const blocks = imageBlocks(r.result).slice(0, 4);
  for (const block of blocks) await addShot($, { title: toolLabel(call.tool), origin: `from ${toolLabel(call.tool)}`, mime: block.mime }, block);
  if (blocks.length) return;

  // Image files the call just wrote: named in its input or output, and modified while it ran.
  const candidates = imagePathsIn(`${JSON.stringify(call)}\n${typeof r.text === "string" ? r.text : ""}`).slice(0, 8);
  if (!candidates.length) return;
  const cwd = await $.session.cwd();
  const home = (await $.env.get("HOME")) ?? "";
  for (const candidate of candidates) {
    const path = absolutePath(candidate, cwd, home);
    const stat = await $.fs.stat(path).catch(() => null);
    if (!stat || stat.kind !== "file" || stat.size === 0 || stat.mtimeMs < started - 2000) continue;
    await addShot($, { title: basename(path), origin: originOf(call), path, mime: mimeForPath(path) });
  }
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
}

async function openShot($: Api, shot: LightboxShot): Promise<void> {
  if (shot.path) {
    await $.process.run(["open", shot.path]);
    return;
  }
  const picture = pixels.get(shot.id);
  if (!picture) return;
  // An image with no file behind it opens from a temporary PNG.
  await $.process.run(["sh", "-c", 'f="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")"; base64 -d > "$f.png" && open "$f.png"; rm -f "$f"'], { stdin: picture.full });
}

/** Whether Claude Code draws real pixels here: kitty graphics outside a multiplexer, unless the option says otherwise. */
async function choosePixels($: Api): Promise<boolean> {
  if (rendererOption === "pixels") return true;
  if (rendererOption === "cells") return false;
  const term = (await $.env.get("TERM")) ?? "";
  const program = (await $.env.get("TERM_PROGRAM")) ?? "";
  const kitty = Boolean(await $.env.get("KITTY_WINDOW_ID"));
  const multiplexed = Boolean((await $.env.get("HERDR_ENV")) || (await $.env.get("TMUX")) || (await $.env.get("ZELLIJ")) || (await $.env.get("STY")));
  return !multiplexed && (/kitty|ghostty/i.test(term) || kitty || /^(ghostty|kitty|wezterm)$/i.test(program));
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false;
  rendererOption = String(options.renderer ?? "auto");
  // An explicit choice holds from the start; "auto" is settled at session start, from the terminal's environment.
  drawsPixels = rendererOption === "pixels";

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const system = await $.process.run(["uname", "-s"]).catch(() => null);
    const remote = (await $.env.get("SSH_CONNECTION")) || (await $.env.get("SSH_TTY"));
    // Opening a file in Preview or Finder only means something on the Mac the person is looking at.
    canOpen = system?.stdout.trim() === "Darwin" && !remote;
    drawsPixels = await choosePixels($);
    await $.tool.register({
      name: "show",
      description: `Show the user an image file in the Lightbox pane of their terminal. Use it whenever you want the user to see an image: a screenshot you took, an image you generated or edited, a diagram you rendered, or an image file you found. Accepts ${FORMATS}. Images you open with the Read tool, and images tools return, appear there by themselves.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The image file: an absolute path, ~/..., or a path relative to the working directory" },
          caption: { type: "string", description: "One short line shown under the image" }
        },
        required: ["path"]
      }
    });
    try {
      await $.command.register({ name: "lightbox", description: "Open the Lightbox: every image this session has read, received or created", argumentHint: "[image path | clear]", immediate: true });
    } catch (err) {
      $.ui.log(`lightbox: /lightbox not registered: ${message(err)}`, { to: "debug" });
    }
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    const result = await next(e);
    // Images the person pastes from files join the reel quietly: they have just seen them.
    if (e.origin.kind === "composer" || e.origin.kind === "bridge") {
      for (const path of pastedImagePaths(e.text).slice(0, 4)) {
        try {
          await showFile($, path, "pasted by you", undefined, true);
        } catch (err) {
          $.ui.log(`lightbox: ${message(err)}`, { to: "debug" });
        }
      }
    }
    return result;
  });

  on("tool.call", async ($, e, next) => {
    const call = e as unknown as Call;
    if (call.tool === SHOW_TOOL) {
      const caption = typeof call.caption === "string" ? call.caption.slice(0, 200) : undefined;
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
      return { text: "Lightbox cleared." };
    }
    if (arg) {
      const said = await showFile($, arg, "opened by you", undefined, true);
      if (!said.startsWith("Showing")) return { text: said };
    }
    await update($, waiting, () => false);
    await $.ui.open({ id: PANE, title: "Lightbox", focus: true });
    return {};
  });

  // The band above the prompt, while a new image waits for a pane too narrow to seat on its own.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, waiting))) return next(e);
    const list = await read($, shots);
    const last = list[list.length - 1];
    if (!last) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="row" paddingX={1} gap={1}>
        <Text color="cyan" bold>lightbox</Text>
        <Text wrap="truncate-middle">{last.title}</Text>
        <Text dimColor>· type /lightbox to view</Text>
      </Box>
    );
  });

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

    const index = Math.max(0, Math.min(await read($, current), list.length - 1));
    const shot = list[index]!;
    const picture = pixels.get(shot.id);
    if (!picture && shot.status !== "failed") $.clock.after(0, () => { void prepare($, shot.id); });

    const viewportRows = e.viewport?.rows ?? 40;
    const hasStrip = list.length > 1;
    const chrome = 2 + 2 + (shot.caption ? 2 : 0) + (hasStrip ? THUMB_ROWS + 3 : 0) + 3;
    const maxRows = e.props.placement === "dock" ? Math.max(6, viewportRows - chrome - 4) : Math.max(6, Math.min(20, Math.floor(viewportRows * 0.5)));
    const box = shot.width && shot.height ? fit(shot.width, shot.height, width, maxRows) : null;

    const sizeLabel = shot.originalWidth && shot.originalHeight ? `${shot.originalWidth}×${shot.originalHeight}` : shot.width ? `${shot.width}×${shot.height}` : "";
    const meta = [shot.origin, ago(Date.now() - shot.at), sizeLabel, formatLabel(shot.mime)].filter(Boolean).join(" · ");

    let view;
    if (shot.status === "failed") {
      view = <Text color="red">Can't show this image: {shot.note ?? "unknown error"}</Text>;
    } else if (picture && box && Image) {
      view = <Image key="main" source={{ png: picture.full }} columns={box.columns} rows={box.rows} alt={`${shot.title} (image)`} />;
    } else if (picture && box && Raster) {
      const cells = cellCache.get(`${shot.id}:full:${box.columns}x${box.rows}`);
      if (!cells) $.clock.after(0, () => { void renderCells($, shot.id, "full", box.columns, box.rows); });
      view = cells ? <Raster key="main" columns={box.columns} rows={box.rows} cells={cells} /> : <Text dimColor>Drawing {shot.title}…</Text>;
    } else if (picture && !Image && !Raster) {
      view = <Text dimColor>This surface does not draw images. Open it instead.</Text>;
    } else {
      view = <Text dimColor>Preparing {shot.title}…</Text>;
    }

    const slots = Math.max(1, Math.min(5, Math.floor((width + 1) / (THUMB_COLUMNS + 3))));
    const first = Math.max(0, Math.min(index - Math.floor(slots / 2), list.length - slots));
    const strip = list.slice(first, first + slots);
    const step = (delta: number) => () => { void update($, current, (i) => ((((i ?? 0) + delta) % list.length) + list.length) % list.length); };

    const thumbnail = (s: LightboxShot) => {
      const thumb = pixels.get(s.id)?.thumb;
      if (!thumb || !s.width || !s.height) return <Text dimColor>…</Text>;
      const size = fit(s.width, s.height, THUMB_COLUMNS, THUMB_ROWS);
      if (Image) return <Image key={`i-${s.id}`} source={{ png: thumb }} columns={size.columns} rows={size.rows} alt={s.title} />;
      if (!Raster) return <Text dimColor wrap="truncate-end">{s.title}</Text>;
      const cells = cellCache.get(`${s.id}:thumb:${size.columns}x${size.rows}`);
      if (!cells) $.clock.after(0, () => { void renderCells($, s.id, "thumb", size.columns, size.rows); });
      return cells ? <Raster key={`r-${s.id}`} columns={size.columns} rows={size.rows} cells={cells} /> : <Text dimColor>…</Text>;
    };

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-middle">{shot.title}</Text>
          <Text dimColor>{index + 1} of {list.length}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{meta}</Text>
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
          <Button key="prev" plain dimColor label="prev" hotkey="h" onPress={step(-1)} />
          <Button key="next" plain dimColor label="next" hotkey="l" onPress={step(1)} />
          {canOpen && (shot.path || picture) ? <Button key="open" plain dimColor label="open" hotkey="o" onPress={() => { void openShot($, shot); }} /> : null}
          {canOpen && shot.path ? <Button key="reveal" plain dimColor label="reveal" hotkey="r" onPress={() => { void $.process.run(["open", "-R", shot.path!]); }} /> : null}
          {shot.path ? <Button key="copy" plain dimColor label="copy" hotkey="c" onPress={() => { void $.ui.copy({ text: shot.path!, surface: e.surface }); }} /> : null}
          <Button key="remove" plain dimColor label="remove" hotkey="x" onPress={() => { void removeShot($, shot.id); }} />
        </Box>
        {e.props.isFocused ? null : <Text dimColor>ctrl+x tab to use the keys, or click</Text>}
      </Box>
    );
  });
};
