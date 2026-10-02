// Lightbox: every image the session reads, receives or creates, drawn in a pane beside the conversation.
// Images come from Read results, image blocks in tool results (screenshots), image files a tool call
// just wrote, the `show` tool Claude calls to send one, and `/lightbox <path>`.

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import type { LightboxShot } from "../types";
import { absolutePath, ago, basename, decodedSize, fit, imageBlocks, imagePathsIn, isPng, mimeForPath, pngSize, toolLabel } from "./images.ts";

type Api = EngineInterface;
type Call = { readonly tool: string; readonly [field: string]: unknown };
type Bytes = { base64: string; mime: string };
type NewShot = { title: string; origin: string; mime: string; path?: string; caption?: string };

const PANE = "lightbox";
const SHOW_TOOL = "mcp__lightbox__show";
const shots = atom({ plugin: "lightbox", key: "shots" } as const, [] as LightboxShot[]);
const current = atom({ plugin: "lightbox", key: "current" } as const, 0);

const REEL_SIZE = 24;
const PIXELS_KEPT = 12;
// The Image element takes at most 2 MiB of PNG.
const PNG_LIMIT = 2 * 1024 * 1024 - 4096;
const FULL_SIDE = 1280;
const SMALLER_SIDE = 800;
const THUMB_SIDE = 256;
const FORMATS = "PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG";

// Prints, as base64, a PNG of the first frame of an image, no longer than $2 pixels on its longest side.
// $1 is a file path, or "-" to read the image from stdin as base64. ImageMagick reads every format
// the Lightbox shows; sips (macOS) is the fallback.
const CONVERT = [
  'in="$1"; side="$2"; tmp=""; out=""',
  'trap \'rm -f "$tmp" "$out"\' EXIT',
  'if [ "$in" = "-" ]; then tmp="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")" || exit 1; base64 -d > "$tmp" || exit 1; in="$tmp"; fi',
  'if command -v magick >/dev/null 2>&1; then magick "$in[0]" -auto-orient -resize "${side}x${side}>" png:-',
  'elif command -v convert >/dev/null 2>&1; then convert "$in[0]" -auto-orient -resize "${side}x${side}>" png:-',
  'elif command -v sips >/dev/null 2>&1; then out="$(mktemp "${TMPDIR:-/tmp}/lightbox.XXXXXX")"; sips -s format png -Z "$side" "$in" --out "$out.png" >/dev/null && cat "$out.png"; rm -f "$out.png"',
  'else echo "no image converter found: install ImageMagick" >&2; exit 127',
  'fi | base64 | tr -d "\\n"'
].join("\n");

// Pictures ready to draw, by shot id: the module's own memory, so a reload prepares them again.
const pixels = new Map<string, { full: string; thumb: string }>();
// Image bytes that arrived with no file behind them, kept until they are prepared.
const inline = new Map<string, Bytes>();
const preparing = new Set<string>();
let autoOpen = true;
let canOpen = false;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 160) ?? "";
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

async function convert($: Api, input: string, stdin: string, side: number): Promise<string> {
  const run = await $.process.run(["sh", "-c", CONVERT, "lightbox", input, String(side)], { stdin, timeoutMs: 30_000 });
  const png = run.stdout.replace(/\s+/g, "");
  if (!isPng(png)) throw new Error(run.stderr.trim().split("\n").pop() || `the converter exited with ${run.exitCode}`);
  return png;
}

/** Turns a shot's bytes or file into PNGs the Image element can draw, then marks it ready. */
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
    if (bytes && isPng(bytes.base64) && decodedSize(bytes.base64) <= PNG_LIMIT) full = bytes.base64;
    if (!bytes && shot.mime === "image/png") {
      const file = await $.fs.read(input, { as: "bytes" }).catch(() => null);
      if (file && decodedSize(file.base64) <= PNG_LIMIT) full = file.base64;
    }
    if (!full) full = await convert($, input, stdin, FULL_SIDE);
    if (decodedSize(full) > PNG_LIMIT) full = await convert($, input, stdin, SMALLER_SIDE);
    const thumb = decodedSize(full) <= 150_000 ? full : await convert($, input, stdin, THUMB_SIDE);
    const size = pngSize(full);
    pixels.set(id, { full, thumb });
    inline.delete(id);
    await update($, shots, (list) => list.map((s) => (s.id === id ? { ...s, status: "ready" as const, ...(size ?? {}) } : s)));
  } catch (err) {
    await update($, shots, (list) => list.map((s) => (s.id === id ? { ...s, status: "failed" as const, note: message(err) } : s)));
  } finally {
    preparing.delete(id);
  }
}

/** Drops pictures and bytes for shots that left the reel or fell out of the recent few. */
function evict(list: readonly LightboxShot[]): void {
  const recent = new Set(list.slice(-PIXELS_KEPT).map((s) => s.id));
  const onReel = new Set(list.map((s) => s.id));
  for (const id of pixels.keys()) if (!recent.has(id)) pixels.delete(id);
  for (const id of inline.keys()) if (!onReel.has(id)) inline.delete(id);
}

async function announce($: Api, title: string): Promise<void> {
  if (autoOpen) {
    const opened = await $.ui.open({ id: PANE, title: "Lightbox" });
    if (opened.isPlaced) return;
  }
  $.ui.toast(`New image: ${title} · /lightbox to view`);
}

/** Puts an image on the reel, makes it the current one, and prepares it in the background. */
async function addShot($: Api, shot: NewShot, bytes?: Bytes): Promise<void> {
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
    ...(shot.caption ? { caption: shot.caption } : {})
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
  await announce($, shot.title);
}

/** Puts an image file on the reel, or says why it cannot. */
async function showFile($: Api, raw: string, origin: string, caption?: string): Promise<string> {
  const path = absolutePath(raw.trim(), await $.session.cwd(), (await $.env.get("HOME")) ?? "");
  const mime = mimeForPath(path);
  if (!mime) return `${basename(path)} is not an image the Lightbox shows (${FORMATS}).`;
  const stat = await $.fs.stat(path).catch(() => null);
  if (!stat || stat.kind !== "file") return `No image file at ${path}.`;
  await addShot($, { title: basename(path), origin, path, mime, ...(caption ? { caption } : {}) });
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
    const value = r.result as { type?: string; file?: { base64?: string; type?: string } } | undefined;
    if (value?.type === "image" && value.file?.base64) {
      const mime = value.file.type ?? "image/png";
      await addShot($, { title: basename(path), origin: "read by Claude", mime, ...(path ? { path } : {}) }, { base64: value.file.base64, mime });
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

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false;

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const system = await $.process.run(["uname", "-s"]).catch(() => null);
    const remote = (await $.env.get("SSH_CONNECTION")) || (await $.env.get("SSH_TTY"));
    // Opening a file in Preview or Finder only means something on the Mac the person is looking at.
    canOpen = system?.stdout.trim() === "Darwin" && !remote;
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
      return { text: "Lightbox cleared." };
    }
    if (arg) {
      const said = await showFile($, arg, "opened by you");
      if (!said.startsWith("Showing")) return { text: said };
    }
    await $.ui.open({ id: PANE, title: "Lightbox", focus: true });
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const Image = e.surface === "terminal" ? $.ui.resolve(e).Image : undefined;
    const list = await read($, shots);
    if (!list.length) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="cyan">◫ Lightbox</Text>
          <Text dimColor>No images yet. Images Claude reads, receives or creates show up here.</Text>
          <Text dimColor>/lightbox path/to/image opens any {FORMATS} file.</Text>
        </Box>
      );
    }

    const index = Math.max(0, Math.min(await read($, current), list.length - 1));
    const shot = list[index]!;
    const picture = pixels.get(shot.id);
    if (!picture && shot.status !== "failed") $.clock.after(0, () => { void prepare($, shot.id); });

    const width = Math.max(10, e.props.bodyColumns - 2);
    const viewportRows = e.viewport?.rows ?? 40;
    const maxRows = e.props.placement === "dock" ? Math.max(6, viewportRows - 14) : Math.max(6, Math.min(24, Math.floor(viewportRows * 0.55)));
    const main = shot.width && shot.height ? fit(shot.width, shot.height, width, maxRows) : null;

    const slots = Math.max(1, Math.min(7, Math.floor(width / 13)));
    const first = Math.max(0, Math.min(index - Math.floor(slots / 2), list.length - slots));
    const strip = list.slice(first, first + slots);
    const step = (delta: number) => () => { void update($, current, (i) => (((i ?? 0) + delta) % list.length + list.length) % list.length); };

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="cyan" wrap="truncate-end">◫ {shot.title}</Text>
          <Text dimColor>{index + 1}/{list.length}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {shot.origin} · {ago(Date.now() - shot.at)}{shot.width ? ` · ${shot.width}×${shot.height}` : ""}
        </Text>
        <Box flexDirection="row" justifyContent="center" marginY={1}>
          {shot.status === "failed" ? (
            <Text color="red">Can't show this image: {shot.note ?? "unknown error"}</Text>
          ) : picture && main && Image ? (
            <Image key="main" source={{ png: picture.full }} columns={main.columns} rows={main.rows} alt={`${shot.title} (image)`} />
          ) : picture && !Image ? (
            <Text dimColor>This surface does not draw images. Open it instead.</Text>
          ) : (
            <Text dimColor>Preparing {shot.title}…</Text>
          )}
        </Box>
        {shot.caption ? <Text italic>{shot.caption}</Text> : null}
        {list.length > 1 && Image ? (
          <Box flexDirection="row" gap={1}>
            {strip.map((s) => {
              const thumb = pixels.get(s.id)?.thumb;
              const size = s.width && s.height ? fit(s.width, s.height, 10, 4) : { columns: 10, rows: 4 };
              return (
                <Box key={`t-${s.id}`} borderStyle="round" borderColor={s.id === shot.id ? "cyan" : "gray"} borderDimColor={s.id !== shot.id} width={12} height={6} justifyContent="center" alignItems="center">
                  {thumb ? <Image key={`i-${s.id}`} source={{ png: thumb }} columns={size.columns} rows={size.rows} alt={s.title} /> : <Text dimColor>…</Text>}
                </Box>
              );
            })}
          </Box>
        ) : null}
        {shot.path ? <Text dimColor wrap="truncate-middle">{shot.path}</Text> : null}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="prev" label="← Prev" hotkey="h" onPress={step(-1)} />
          <Button key="next" label="Next →" hotkey="l" onPress={step(1)} />
          {canOpen && (shot.path || picture) ? <Button key="open" label="Open" hotkey="o" onPress={() => { void openShot($, shot); }} /> : null}
          {canOpen && shot.path ? <Button key="reveal" label="Reveal" hotkey="r" onPress={() => { void $.process.run(["open", "-R", shot.path!]); }} /> : null}
          {shot.path ? <Button key="copy" label="Copy path" hotkey="c" onPress={() => { void $.ui.copy({ text: shot.path!, surface: e.surface }); }} /> : null}
          <Button key="remove" label="Remove" hotkey="x" onPress={() => { void removeShot($, shot.id); }} />
        </Box>
      </Box>
    );
  });
};
