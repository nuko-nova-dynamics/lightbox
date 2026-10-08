// Runs under `claude plugin test .`: the mod loaded by Claude Code's own host, with the engine stubbed beneath it.

import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";
import { imagesAfterText } from "../hooks/images.ts";

// A 4×2 PNG, and an 8×4 BMP of it: what the converters print, as base64.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqCgIBCBU/dEa6AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTEwLTAyVDAxOjA4OjIxKzAwOjAwtrm37wAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMC0wMlQwMTowODoyMSswMDowMMfkD1MAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTAtMDJUMDE6MDg6MjErMDA6MDCQ8S6MAAAAEGNhTnYAAAACAAAAAgAAAAAAAAAAHZy6YQAAABlJREFUCNdj/M/AwMDAwMjwn4GBgYkBCQAAKjcCA2vNi70AAAAASUVORK5CYII=";
const BMP = "Qk2WAAAAAAAAADYAAAAoAAAACAAAAAQAAAABABgAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/PgDBwQA+/wAA/wAA/wAAAAD/AAD/AAD/PgDBwQA+/wAA/wAA/wAAAAD/AAD/AAD/PgDBwQA+/wAA/wAA/wAAAAD/AAD/AAD/PgDBwQA+/wAA/wAA/wAA";

const PANE = {
  plugin: "lightbox",
  surface: "terminal",
  component: "Pane",
  requestId: "lightbox",
  props: { title: "Lightbox", isFocused: false, bodyColumns: 80, placement: "dock", scroll: { top: 0 }, view: {} }
} as any;
const BAND = { plugin: "lightbox", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as any;
const PIXELS = { options: { renderer: "pixels" } } as any;
const CELLS = { options: { renderer: "cells" } } as any;

/** The engine beneath the mod: a held clock, a pane that seats (or not), and tools that return images. */
function world(on: On, files: Record<string, number> = {}, seats = true, below?: string) {
  const converted: string[][] = [];
  const clock = mock.clock(on, { now: 1_000 });
  on("ui.open", () => ({ value: seats ? { isPlaced: true } : { isPlaced: false, reason: "narrow" } }) as any);
  on("ui.toast", () => ({ value: undefined }) as any);
  on("ui.panes", () => ({ value: [] }) as any);
  // The band beneath Lightbox: empty, as the engine draws it, or a line another mod drew.
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    return Box({ children: below ? Text({ children: below }) : undefined });
  });
  on("session.cwd", () => ({ value: "/work" }));
  on("env.get", ($, e) => ({ value: e.name === "HOME" ? "/home/me" : undefined }) as any);
  // A file exists when listed, with the given modification time.
  on("fs.stat", ($, e) => (e.path in files ? { value: { kind: "file", size: 10, mtimeMs: files[e.path] ?? 0, isLink: false } } : { deny: "ENOENT" }) as any);
  on("fs.read", () => ({ value: { base64: PNG } }) as any);
  on("process.run", ($, e) => {
    converted.push([...e.argv]);
    const script = String(e.argv[2] ?? "");
    if (script.includes("bmp3")) return { value: { exitCode: 0, stdout: BMP, stderr: "" } } as any;
    return { value: { exitCode: 0, stdout: PNG, stderr: "dims 4032 3024\n" } } as any;
  });
  on("tool.call", ($, e) => {
    if (e.tool === "Read" && String(e.file_path).endsWith(".png")) return { result: { type: "image", file: { base64: PNG, type: "image/png", originalSize: 70 } } } as any;
    if (e.tool === "Read") return { result: { type: "text", file: { content: "" } } } as any;
    if ((e.tool as string) === "mcp__shots__burst") return { result: Array.from({ length: 5 }, () => ({ type: "image", data: PNG, mimeType: "image/png" })) } as any;
    if (String(e.tool).startsWith("mcp__shots__")) return { result: [{ type: "text", text: "captured" }, { type: "image", data: PNG, mimeType: "image/png" }] } as any;
    return { result: "ran" } as any;
  });
  /** Lets background work (preparing pictures, fitting cells) run. */
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) {
      await clock.advance(1);
      await clock.settle();
    }
  };
  return { converted, settle };
}

test("an image Claude reads shows in the strip above the prompt, in pixels where the terminal can", PIXELS, async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Read", file_path: "/work/shot.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Image" })).toBeDefined();
  expect(await band.find({ type: "Text", text: /shot\.png/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: /read by Claude/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: /just now · 4×2 · PNG/ })).toBeDefined();
  await band.unmount();
});

test("inside a multiplexer the picture is drawn in quadrant cells", CELLS, async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "mcp__shots__take_screenshot" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  await w.settle();
  expect(await band.find({ type: "Raster" })).toBeDefined();
  expect(await band.find({ type: "Image" })).toBeUndefined();
  expect(w.converted.some((argv) => String(argv[2]).includes("bmp3"))).toBe(true);
  await band.unmount();
});

test("a HEIC is converted once, small, for the strip; the larger picture waits for the pane", PIXELS, async ($, on) => {
  const w = world(on, { "/work/IMG_0001.HEIC": 0 });
  await $.tool.call({ tool: "Read", file_path: "/work/IMG_0001.HEIC" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Image" })).toBeDefined();
  expect(await band.find({ type: "Text", text: /4032×3024 · HEIC/ })).toBeDefined();
  const sides = () => w.converted.filter((argv) => argv[4] === "/work/IMG_0001.HEIC").map((argv) => [argv[5], argv[6]]);
  expect(sides()).toEqual([["480", "image/heic"]]);
  await band.unmount();
  const pane = await $.ui.mount(PANE);
  await w.settle();
  expect(sides()).toEqual([["480", "image/heic"], ["1280", "image/heic"]]);
  expect(await pane.find({ type: "Image" })).toBeDefined();
  await pane.unmount();
});

test("images that arrive together show side by side in the strip", PIXELS, async ($, on) => {
  const w = world(on, { "/work/a.png": 0, "/work/b.png": 0 });
  await $.tool.call({ tool: "mcp__lightbox__show", path: "a.png" } as any);
  await $.tool.call({ tool: "mcp__lightbox__show", path: "b.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.findAll({ type: "Image" })).toHaveLength(2);
  expect(await band.find({ type: "Text", text: /b\.png/ })).toBeDefined();
  await band.unmount();
});

test("folding the strip leaves one line; a new image opens it again", PIXELS, async ($, on) => {
  const w = world(on, { "/work/a.png": 0, "/work/b.png": 0 });
  await $.tool.call({ tool: "mcp__lightbox__show", path: "a.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  await $.ui.press({ plugin: "lightbox", key: "fold" });
  expect(await band.find({ type: "Button", key: "expand" })).toBeDefined();
  expect(await band.find({ type: "Button", key: "view" })).toBeUndefined();
  await $.tool.call({ tool: "mcp__lightbox__show", path: "b.png" } as any);
  await w.settle();
  expect(await band.find({ type: "Button", key: "view" })).toBeDefined();
  expect(await band.find({ type: "Button", key: "expand" })).toBeUndefined();
  await band.unmount();
});

test("an image a command just wrote is captured; one it only mentions is not", PIXELS, async ($, on) => {
  const w = world(on, { "/work/new.png": Date.now(), "/work/old.png": 0 });
  await $.tool.call({ tool: "Bash", command: "cd /work && timeout 30 /usr/sbin/screencapture -x new.png && ls old.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: /new\.png/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: /from screencapture/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: /old\.png/ })).toBeUndefined();
  await band.unmount();
});

test("the show tool sends an image, and says why when it cannot", PIXELS, async ($, on) => {
  world(on, { "/work/diagram.svg": 0 });
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "notes.txt" } as any)).result).toMatch(/not an image/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "/nope/x.png" } as any)).result).toMatch(/No image file at \/nope\/x\.png/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "diagram.svg", caption: "the flow" } as any)).result).toMatch(/Showing diagram\.svg/);
});

test("a prompt queued while Claude works finds its images after its text in the conversation", async () => {
  const text = "<system-reminder>The user sent: [Image #3] like this</system-reminder>";
  const messages = [
    { role: "user", content: [{ type: "text", text: "earlier" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "OLD" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "TOOL" } }] },
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } },
        { type: "text", text: "after" }
      ]
    }
  ];
  expect(imagesAfterText(messages, "[Image #3] like this")).toEqual([{ base64: PNG, mime: "image/jpeg" }]);
  expect(imagesAfterText(messages, "not there")).toEqual([]);
  // The same text queued again later, with no image of its own, does not take the earlier one's.
  messages[2]!.content.push({ type: "text", text } as any);
  expect(imagesAfterText(messages, "[Image #3] like this")).toEqual([]);
});

test("the strip shrinks to fit a short band instead of scrolling, down to one line", PIXELS, async ($, on) => {
  const w = world(on, { "/work/a.png": 0 });
  await $.tool.call({ tool: "mcp__lightbox__show", path: "a.png" } as any);
  await w.settle();
  const short = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 4 } });
  const image = await short.find({ type: "Image" });
  expect(Number(image?.props.rows)).toBeLessThanOrEqual(2);
  expect(await short.find({ type: "Button", key: "hide" })).toBeDefined();
  await short.unmount();
  const tiny = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 3 } });
  expect(await tiny.find({ type: "Button", key: "view" })).toBeDefined();
  expect(await tiny.find({ type: "Button", key: "expand" })).toBeUndefined();
  expect(await tiny.find({ type: "Button", key: "fold" })).toBeUndefined();
  await tiny.unmount();
});

test("images from tool calls that finish together all show", PIXELS, async ($, on) => {
  const w = world(on);
  await Promise.all([$.tool.call({ tool: "mcp__shots__take_screenshot" } as any), $.tool.call({ tool: "mcp__shots__take_screenshot" } as any)]);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.findAll({ type: "Image" })).toHaveLength(2);
  expect(await band.find({ type: "Text", text: /✕/ })).toBeUndefined();
  await band.unmount();
});

test("an image a command wrote to a quoted path with spaces is captured", PIXELS, async ($, on) => {
  const w = world(on, { "/private/tmp/my diagram.png": Date.now() });
  await $.tool.call({ tool: "Bash", command: 'magick -size 10x10 xc:red "/private/tmp/my diagram.png"' } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: /my diagram\.png/ })).toBeDefined();
  await band.unmount();
});

test("every image of a result past four goes on the reel", PIXELS, async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "mcp__shots__burst" } as any);
  await w.settle();
  const pane = await $.ui.mount(PANE);
  expect(await pane.find({ type: "Text", text: /5 of 5/ })).toBeDefined();
  await pane.unmount();
});

test("opening a file with /lightbox unfolds a folded strip", PIXELS, async ($, on) => {
  const w = world(on, { "/work/a.png": 0, "/work/b.png": 0 });
  await $.tool.call({ tool: "mcp__lightbox__show", path: "a.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  await $.ui.press({ plugin: "lightbox", key: "fold" });
  expect(await band.find({ type: "Button", key: "expand" })).toBeDefined();
  await $.command.run({ command: "lightbox", args: "b.png" } as any);
  await w.settle();
  expect(await band.find({ type: "Button", key: "expand" })).toBeUndefined();
  await band.unmount();
});

test("a relative image written after cd is found where the command went", PIXELS, async ($, on) => {
  const w = world(on, { "/other/out.png": Date.now() });
  await $.tool.call({ tool: "Bash", command: "cd /other && magick -size 10x10 xc:red out.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: /out\.png/ })).toBeDefined();
  await band.unmount();
});

test("a caption of several lines shows as one", PIXELS, async ($, on) => {
  const w = world(on, { "/work/a.png": 0 });
  await $.tool.call({ tool: "mcp__lightbox__show", path: "a.png", caption: "first\nsecond\nthird" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "first second third" })).toBeDefined();
  await band.unmount();
});

test("what the mods after Lightbox draw in the band stays under the strip", PIXELS, async ($, on) => {
  const w = world(on, {}, true, "drawn below");
  await $.tool.call({ tool: "Read", file_path: "/work/shot.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Image" })).toBeDefined();
  expect(await band.find({ type: "Text", text: /drawn below/ })).toBeDefined();
  await band.unmount();
  // A short band: the row beneath keeps its place and the strip shrinks to one line.
  const short = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 4 } });
  expect(await short.find({ type: "Text", text: /drawn below/ })).toBeDefined();
  expect((await short.find({ type: "Image" }))?.props?.rows).toBe(1);
  await short.unmount();
});
