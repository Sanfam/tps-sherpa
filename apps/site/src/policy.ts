/**
 * A privacy policy's Discord markdown as HTML for the /privacy page. Everything
 * is escaped, then only the markup the files use is restored: **bold** and
 * `code`. Newlines are kept for white-space: pre-line, so the • lines stay lines.
 */
export const renderPolicy = (text: string) =>
  text
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
