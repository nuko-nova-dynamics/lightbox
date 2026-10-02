# Lightbox

A Claude Code mod that shows images in your terminal. Every image the session touches lands in a pane beside the conversation:

- images Claude opens with the Read tool
- screenshots and other images that tools return (Chrome DevTools, Peekaboo, simulator and computer-use tools)
- image files a command or tool call just wrote: `screencapture`, `xcrun simctl io booted screenshot`, an image generator's output
- images Claude sends you on purpose with its `show` tool
- any file you open with `/lightbox path/to/image`

It reads PNG, JPEG, GIF, WebP, HEIC/HEIF, AVIF, TIFF, BMP and SVG. Images other than small PNGs are converted with ImageMagick (or `sips` on macOS) to a PNG no larger than 1280 pixels, so the picture travels as bytes and also works when Claude Code runs on another machine over SSH.

## Using it

- `/lightbox` opens the pane. `/lightbox <path>` shows a file, and `/lightbox clear` empties the reel.
- In the pane, `h` and `l` step back and forward, `o` opens the image in Preview, `r` reveals it in Finder, `c` copies its path, and `x` removes it. Press ctrl+x then Tab, or click the pane, to give it the keyboard.
- A strip of thumbnails under the picture shows the images around the current one.
- The pane opens by itself when a new image arrives. Turn that off with the `autoOpen` option, and a toast says an image arrived instead.

Pictures draw with the kitty graphics protocol, so the terminal must speak it: Ghostty, kitty, WezTerm and iTerm2 do, and herdr passes it through. Elsewhere the pane shows the image's name in its place. Open and Reveal appear only on a Mac you are sitting at, not over SSH.

The reel keeps the last 24 images per session, with pictures for the 12 most recent held in memory.

## Developing

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .        # a session that reloads the mod on save
```

`hooks/register.tsx` is the mod; `hooks/images.ts` holds the parts that touch nothing outside: formats, PNG headers, paths and layout.

## License

MIT
