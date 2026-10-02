# Lightbox

A Claude Code mod that shows images in your terminal. Every image the session touches lands in a pane beside the conversation:

- images Claude opens with the Read tool
- screenshots and other images that tools return (Chrome DevTools, Peekaboo, simulator and computer-use tools)
- image files a command or tool call just wrote: `screencapture`, `xcrun simctl io booted screenshot`, an image generator's output
- images Claude sends you on purpose with its `show` tool
- images you paste into a prompt from a file (they join the reel quietly)
- any file you open with `/lightbox path/to/image`

It reads PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG. Images other than small PNGs are converted with ImageMagick, or with `sips` on macOS when ImageMagick cannot decode a file, to a PNG no larger than 1280 pixels.

![The Lightbox design](design/mockup.png)

## How pictures are drawn

Where Claude Code can draw real pixels (Ghostty, kitty or WezTerm with nothing in between), the Lightbox uses them. Inside a multiplexer such as herdr, tmux or zellij, and over SSH, it draws the picture with Unicode quadrant blocks instead: each terminal cell shows two colors over a 2×2 grid, fitted to the pixels under it. That works in any terminal with true color. The `renderer` option forces either one: `pixels`, `cells`, or `auto` (the default).

![A photo, and the same photo in quadrant cells at 64×23 cells](design/cells-preview.png)

## Using it

- `/lightbox` opens the pane. `/lightbox <path>` shows a file, and `/lightbox clear` empties the reel.
- In the pane, `h` and `l` step back and forward, `o` opens the image in Preview, `r` reveals it in Finder, `c` copies its path, and `x` removes it. Press ctrl+x then Tab, or click the pane, to give it the keyboard; the footer says so while it does not have it.
- A strip of framed thumbnails under the picture shows the images around the current one, the current one outlined in cyan.
- The header gives the file name and its place on the reel; the line under it says who brought the image in, when, its original size and its format.
- The pane opens by itself when a new image arrives. When the terminal is too narrow for Claude Code to seat a pane unasked, a band above the prompt says an image is waiting instead. Turn auto-opening off with the `autoOpen` option, and a toast says an image arrived.

Open and Reveal appear only on a Mac you are sitting at, not over SSH.

The reel keeps the last 24 images per session, with pictures for the 12 most recent held in memory.

## Developing

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .        # a session that reloads the mod on save
```

`hooks/register.tsx` is the mod. `hooks/images.ts` and `hooks/cells.ts` touch nothing outside it: formats, PNG headers, paths and layout, and the quadrant-cell renderer (a BMP reader and the fitting of two colors to each 2×2 block). `design/mockup.png` is the design the pane is built to.

## License

MIT
