// Runs under `claude plugin test .`: the mod loaded by Claude Code's own host, with the engine stubbed beneath it.

import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

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
function world(on: On, files: Record<string, number> = {}, seats = true) {
  const converted: string[][] = [];
  const clock = mock.clock(on, { now: 1_000 });
  on("ui.open", () => ({ value: seats ? { isPlaced: true } : { isPlaced: false, reason: "narrow" } }) as any);
  on("ui.toast", () => ({ value: undefined }) as any);
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

test("an image Claude reads opens the Lightbox and is drawn in pixels where the terminal can", PIXELS, async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Read", file_path: "/work/shot.png" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Image" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /shot\.png/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /read by Claude · just now · 4×2 · PNG/ })).toBeDefined();
  await ui.unmount();
});

test("inside a multiplexer the picture is drawn in quadrant cells", CELLS, async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "mcp__shots__take_screenshot" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  await w.settle();
  expect(await ui.find({ type: "Raster" })).toBeDefined();
  expect(await ui.find({ type: "Image" })).toBeUndefined();
  expect(w.converted.some((argv) => String(argv[2]).includes("bmp3"))).toBe(true);
  await ui.unmount();
});

test("a HEIC is converted, and the meta line gives its original size and format", PIXELS, async ($, on) => {
  const w = world(on, { "/work/IMG_0001.HEIC": 0 });
  await $.tool.call({ tool: "Read", file_path: "/work/IMG_0001.HEIC" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Image" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /4032×3024 · HEIC/ })).toBeDefined();
  await ui.unmount();
});

test("an image a command just wrote is captured; one it only mentions is not", PIXELS, async ($, on) => {
  const w = world(on, { "/work/new.png": Date.now(), "/work/old.png": 0 });
  await $.tool.call({ tool: "Bash", command: "screencapture -x new.png && ls old.png" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: /new\.png/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /from screencapture/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /old\.png/ })).toBeUndefined();
  await ui.unmount();
});

test("when the pane cannot seat, the band above the prompt says an image is waiting", PIXELS, async ($, on) => {
  const w = world(on, {}, false);
  await $.tool.call({ tool: "Read", file_path: "/work/shot.png" } as any);
  await w.settle();
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: /shot\.png/ })).toBeDefined();
  expect(await band.find({ type: "Text", text: /\/lightbox to view/ })).toBeDefined();
  await band.unmount();
});

test("the show tool sends an image, and says why when it cannot", PIXELS, async ($, on) => {
  world(on, { "/work/diagram.svg": 0 });
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "notes.txt" } as any)).result).toMatch(/not an image/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "/nope/x.png" } as any)).result).toMatch(/No image file at \/nope\/x\.png/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "diagram.svg", caption: "the flow" } as any)).result).toMatch(/Showing diagram\.svg/);
});
