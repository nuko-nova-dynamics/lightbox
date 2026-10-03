# Lightbox

A Claude Code mod that shows images in your terminal, in a small strip right above the prompt. Claude Code shows an image you paste as `[Image #1]`, and an image Claude reads or makes as nothing at all; the Lightbox draws them:

- images you paste into a prompt, named `Image #1`, `Image #2` as the transcript names them
- images Claude opens with the Read tool
- screenshots and other images that tools return (Chrome DevTools, Peekaboo, simulator and computer-use tools)
- image files a command or tool call just wrote: `screencapture`, `xcrun simctl io booted screenshot`, an image generator's output (but not Claude's own scratch files)
- images Claude sends you on purpose with its `show` tool
- any file you open with `/lightbox path/to/image`

It reads PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG. Each image is decoded once into a PNG of at most 480 pixels for the strip: with `sips` first for HEIC on macOS, which is several times faster there, and ImageMagick first for everything else. The larger view gets a 1280-pixel picture only when you open it.

Requires Claude Code 2.1.288 or later.

## Install

```
/plugin marketplace add nuko-nova-dynamics/marketplace
/plugin install lightbox@nuko-nova-tools
```

## The strip

- Images that arrive together, several pasted at once or sent at once, sit side by side, up to four. Each has a frame; the current one's is lit in its sender's color, cyan for yours and orange for Claude's.
- Beside them: the current image's name, a dot for each image on the reel (the current one filled, batches spaced apart), who brought it in, when, its original size and its format.
- `h` and `l` step through the images, `v` opens the larger view, `o` opens the image in Preview, `f` folds the strip and `x` hides it. Press ctrl+x then Tab to give the strip the keyboard; a click works without it.
- When you send a message with no image, the strip folds to one line with its pictures a row tall. The next image opens it again.
- `/lightbox` opens a folded or hidden strip and hides an open one. `/lightbox <path>` shows a file, `/lightbox view` opens the larger view, and `/lightbox clear` empties the reel.

The larger view is a pane with the current image as large as the pane allows and thumbnails of the images around it; the strip steps aside while it shows. In it, `h` and `l` step, `o` opens in Preview, `r` reveals in Finder, `c` copies the path and `x` removes the image.

Open and Reveal appear only on a Mac you are sitting at, not over SSH. The reel keeps the last 24 images per session, with pictures for the 12 most recent held in memory.

## How pictures are drawn

Where Claude Code can draw real pixels (Ghostty, kitty or WezTerm with nothing in between), the Lightbox uses them. Inside a multiplexer such as herdr, tmux or zellij, and over SSH, it draws the picture with Unicode quadrant blocks instead: each terminal cell shows two colors over a 2×2 grid, fitted to the pixels under it. That works in any terminal with true color. The `renderer` option forces either one: `pixels`, `cells`, or `auto` (the default).

![A photo, and the same photo in quadrant cells at 64×23 cells](design/cells-preview.png)

### Real pixels inside herdr

herdr renders kitty graphics, but Claude Code decides whether to draw pixels by asking the terminal its name and accepting only kitty or ghostty. herdr answers `libghostty`, so Claude Code shows images as text there. Set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` in herdr panes to turn pixels on; the Lightbox follows the same variable. In `~/.zshrc`:

```sh
if [[ -n $HERDR_ENV && $TERM_PROGRAM == ghostty ]]; then
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
fi
```

### Proportions

A terminal stretches a picture to fill the cells it is given, so the Lightbox needs to know how tall a cell is against its width. The `cellAspect` option says so: about 2.1 for most fonts, more with taller lines (Ghostty's `adjust-cell-height`). JetBrains Mono at 14 points with `adjust-cell-height = 10%` is 2.5. Set it in `~/.claude/settings.json`:

```json
"pluginConfigs": { "lightbox@nuko-nova-tools": { "options": { "cellAspect": 2.5 } } }
```

## Options

- `autoOpen` (on by default): a new image shows the strip again after you hid it. Off, a toast says one arrived instead.
- `renderer`: `auto`, `cells` or `pixels`, as above.
- `cellAspect`: a cell's height against its width, as above.

## Developing

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .        # a session that reloads the mod on save
```

`hooks/register.tsx` is the mod. `hooks/images.ts` and `hooks/cells.ts` touch nothing outside it: formats, PNG headers, paths and layout, and the quadrant-cell renderer (a BMP reader and the fitting of two colors to each 2×2 block).

## License

MIT
