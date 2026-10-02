/** One image on the reel: where it came from, and whether its pixels are ready to draw. */
export type LightboxShot = {
  id: string;
  /** The file name, or the tool that produced an image with no file. */
  title: string;
  /** Who put it on the reel, in words: "read by Claude", "sent by Claude", "from peekaboo". */
  origin: string;
  /** The absolute path when the image is a file on this machine. */
  path?: string;
  /** The MIME type it arrived as. */
  mime: string;
  /** When it arrived, in milliseconds. */
  at: number;
  /** A line Claude attached when sending it. */
  caption?: string;
  /** Size of the prepared picture, in pixels. */
  width?: number;
  height?: number;
  /** Size of the original image, in pixels. */
  originalWidth?: number;
  originalHeight?: number;
  status: "pending" | "ready" | "failed";
  /** Why it could not be shown. */
  note?: string;
};

declare module "claude-code" {
  interface PluginState {
    lightbox: {
      shots: LightboxShot[];
      current: number;
      /** A new image arrived while the pane could not be drawn; the band above the prompt says so. */
      waiting: boolean;
    };
  }
}
