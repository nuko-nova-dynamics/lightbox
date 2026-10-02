// Runs under `claude plugin test .`: the mod loaded by Claude Code's own host, with the engine stubbed beneath it.

import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

// A 4×2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAGklEQVR4nGP4z8DAwPCfAUT9/w9CYMZ/EAMAlYYL9fO+XmAAAAAASUVORK5CYII=";

const PANE = {
  plugin: "lightbox",
  surface: "terminal",
  component: "Pane",
  requestId: "lightbox",
  props: { title: "Lightbox", isFocused: false, bodyColumns: 80, placement: "dock", scroll: { top: 0 }, view: {} }
} as any;

/** The engine beneath the mod: a held clock, a pane that seats, and tools that return images. */
function world(on: On, files: Record<string, number> = {}) {
  const opened: string[] = [];
  const converted: string[][] = [];
  const clock = mock.clock(on, { now: 1_000 });
  on("ui.open", ($, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.toast", () => ({ value: undefined }));
  on("session.cwd", () => ({ value: "/work" }));
  on("env.get", ($, e) => ({ value: e.name === "HOME" ? "/home/me" : undefined }));
  // A file exists when listed, with the given modification time.
  on("fs.stat", ($, e) => (e.path in files ? { value: { kind: "file", size: 10, mtimeMs: files[e.path], isLink: false } } : { deny: "ENOENT" }));
  on("fs.read", () => ({ value: { base64: PNG } }));
  on("process.run", ($, e) => {
    converted.push([...e.argv]);
    return { value: { exitCode: 0, stdout: PNG, stderr: "" } };
  });
  on("tool.call", ($, e) => {
    if (e.tool === "Read" && String(e.file_path).endsWith(".png")) return { result: { type: "image", file: { base64: PNG, type: "image/png", originalSize: 70 } } };
    if (e.tool === "Read") return { result: { type: "text", file: { content: "" } } };
    if (String(e.tool).startsWith("mcp__shots__")) return { result: [{ type: "text", text: "captured" }, { type: "image", data: PNG, mimeType: "image/png" }] };
    return { result: "ran" };
  });
  /** Lets the background preparation run. */
  const settle = async () => {
    await clock.advance(1);
    await clock.settle();
  };
  return { opened, converted, settle };
}

test("an image Claude reads opens the Lightbox and is drawn", async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Read", file_path: "/work/shot.png" } as any);
  await w.settle();
  expect(w.opened).toContain("lightbox");
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Image" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /shot\.png/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /read by Claude/ })).toBeDefined();
  await ui.unmount();
});

test("a screenshot a tool returns as an image block is drawn", async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "mcp__shots__take_screenshot" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Image" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /from shots take_screenshot/ })).toBeDefined();
  await ui.unmount();
});

test("an image a command just wrote is captured; one it only mentions is not", async ($, on) => {
  const w = world(on, { "/work/new.png": Date.now(), "/work/old.png": 0 });
  await $.tool.call({ tool: "Bash", command: "screencapture -x new.png && ls old.png" } as any);
  await w.settle();
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: /new\.png/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /from screencapture/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /old\.png/ })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /1\/1/ })).toBeDefined();
  await ui.unmount();
});

test("a HEIC goes through the converter and is drawn as a PNG", async ($, on) => {
  const w = world(on, { "/work/IMG_0001.HEIC": 0 });
  await $.tool.call({ tool: "Read", file_path: "/work/IMG_0001.HEIC" } as any);
  await w.settle();
  expect(w.converted.some((argv) => argv[0] === "sh" && argv.includes("/work/IMG_0001.HEIC"))).toBe(true);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Image" })).toBeDefined();
  await ui.unmount();
});

test("the show tool sends an image, and says why when it cannot", async ($, on) => {
  world(on, { "/work/diagram.svg": 0 });
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "notes.txt" } as any)).result).toMatch(/not an image/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "/nope/x.png" } as any)).result).toMatch(/No image file at \/nope\/x\.png/);
  expect((await $.tool.call({ tool: "mcp__lightbox__show", path: "diagram.svg", caption: "the flow" } as any)).result).toMatch(/Showing diagram\.svg/);
});
