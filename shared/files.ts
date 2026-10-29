/**
 * What the phone may open among the files a session's Claude wrote (spec 7.1, file route). The extension decides
 * the Content-Type, and a file with any other extension is not served at all. The set is the kinds a browser
 * renders on its own; a written .md or .json stays a plain chip until someone needs it.
 */
export const VIEWABLE_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** The Content-Type to serve `path` with, or null when the phone may not open it. */
export function viewableType(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot <= slash + 1 ? null : (VIEWABLE_TYPES[path.slice(dot).toLowerCase()] ?? null);
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
