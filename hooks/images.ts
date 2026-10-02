// Image facts the Lightbox needs, with no access to anything outside: formats, sizes, paths, layout.

/** File extensions the Lightbox shows, and the MIME type each one arrives as. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  svg: "image/svg+xml"
};

const EXTENSIONS = Object.keys(MIME_BY_EXTENSION).join("|");

// An image path inside free text: absolute, ~/..., ./... or a bare relative name, ending in a known extension.
const IMAGE_PATH_RE = new RegExp(`(?:^|[\\s'"=(\`:,\\[])((?:~|\\.{1,2})?/?[^\\s'"=()\`:;,|&<>\\[\\]]*\\.(?:${EXTENSIONS}))(?=$|[\\s'"),;:\`\\]])`, "gim");

/** The MIME type for a path's extension, or "" when the Lightbox does not show that kind of file. */
export function mimeForPath(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return MIME_BY_EXTENSION[ext] ?? "";
}

/** Image file paths mentioned in a piece of text, each once, in the order they appear. */
export function imagePathsIn(text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(IMAGE_PATH_RE.source, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || "")))) if (m[1]) out.add(m[1]);
  return [...out];
}

/** A path made absolute: `~/x` against home, a relative one against the working directory. */
export function absolutePath(path: string, cwd: string, home: string): string {
  if (path.startsWith("~/")) return `${home.replace(/\/$/, "")}/${path.slice(2)}`;
  if (path.startsWith("/")) return path;
  const parts = `${cwd.replace(/\/$/, "")}/${path}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Inline image bytes in a tool's result: MCP `{ type: "image", data, mimeType }` and Messages API `source` blocks, a few levels deep. */
export function imageBlocks(value: unknown): { base64: string; mime: string }[] {
  const out: { base64: string; mime: string }[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    const block = v as Record<string, unknown>;
    if (block.type === "image") {
      if (typeof block.data === "string") out.push({ base64: block.data, mime: String(block.mimeType ?? "image/png") });
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === "base64" && typeof source.data === "string") out.push({ base64: source.data, mime: String(source.media_type ?? "image/png") });
      return;
    }
    if ("content" in block) visit(block.content, depth + 1);
  };
  visit(value, 0);
  return out;
}

/** True when base64 bytes are a PNG file. */
export function isPng(base64: string): boolean {
  return base64.startsWith("iVBORw0KGgo");
}

/** How many bytes base64 text decodes to. */
export function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The bytes of a short run of unpadded base64: enough to read a file header. */
function headerBytes(base64: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of base64) {
    const value = BASE64_ALPHABET.indexOf(ch);
    if (value < 0) break;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/** A PNG's pixel size from its header, or null when the bytes are not a PNG. */
export function pngSize(base64: string): { width: number; height: number } | null {
  if (!isPng(base64)) return null;
  const head = headerBytes(base64.slice(0, 32));
  const at = (i: number) => (((head[i] ?? 0) << 24) | ((head[i + 1] ?? 0) << 16) | ((head[i + 2] ?? 0) << 8) | (head[i + 3] ?? 0)) >>> 0;
  const width = at(16);
  const height = at(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1;

/** The largest box of cells within the limits that keeps the picture's proportions. */
export function fit(width: number, height: number, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  const clamp = (n: number, hi: number) => Math.max(1, Math.min(hi, Math.round(n)));
  let columns = Math.min(maxColumns, 255);
  let rows = (columns * height) / width / CELL_ASPECT;
  if (rows > maxRows) {
    rows = maxRows;
    columns = (rows * CELL_ASPECT * width) / height;
  }
  return { columns: clamp(columns, Math.min(maxColumns, 255)), rows: clamp(rows, Math.min(maxRows, 255)) };
}

/** A tool name for people: `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot` → `chrome-devtools take_screenshot`. */
export function toolLabel(tool: string): string {
  const m = tool.match(/^mcp__(?:plugin_[^_]+_)?(.+?)__(.+)$/);
  return m ? `${m[1]} ${m[2]}` : tool;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
