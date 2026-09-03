import JSZip from "jszip";

/**
 * Generate a valid EPUB file from translated text chunks.
 *
 * Structure of the finished book:
 *   1. A proper title page (book title + author) as the first page of the book.
 *   2. The translated chunks in original order. Real chapter headings that the
 *      translator kept (e.g. "Chapter 12", "第 3 卷") are rendered as headings —
 *      we do NOT inject fake "Chapter N" labels, which used to duplicate or
 *      mislabel the book's real chapters.
 *
 * Compression is kept at level 1 on purpose: JSZip's DEFLATE runs in pure JS on
 * the phone, and level 6-9 over a multi-megabyte book used to make the download
 * take 10-20+ seconds. Level 1 is ~5x faster for a modest size increase.
 */

interface BookPart {
  id: string;
  label: string;
  href: string;
}

export async function generateEpub(
  chunks: { index: number; text: string }[],
  title: string,
  fileName: string,
): Promise<Blob> {
  void fileName; // kept in the signature — a stable download name is derived by the caller
  const zip = new JSZip();

  const bookTitle = escapeXml(title.trim() || "Translated Novel");

  // EPUB requires this exact string first and uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  // META-INF/container.xml
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // Order the chunks exactly as they came from the source file.
  const sorted = [...chunks]
    .filter((c) => c.text.trim().length > 0)
    .sort((a, b) => a.index - b.index);

  const author = detectAuthor(sorted.map((c) => c.text));

  // ── Book parts (title page first, then the translated chunks) ──
  const parts: BookPart[] = [{ id: "titlepage", label: "Title Page", href: "title.xhtml" }];

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i];
    const id = `part_${String(i + 1).padStart(4, "0")}`;
    const href = `${id}.xhtml`;

    const paragraphs = chunk.text
      .split(/\r?\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If the chunk starts with a real chapter heading, keep it as a heading —
    // otherwise the chunk is a continuation in the middle of a chapter.
    let heading = "";
    let bodyParagraphs = paragraphs;
    if (paragraphs.length > 0 && looksLikeHeading(paragraphs[0])) {
      heading = paragraphs[0];
      bodyParagraphs = paragraphs.slice(1);
    }

    const label = heading ? shorten(heading) : `Part ${i + 1}`;

    zip.file(
      `OEBPS/${href}`,
      chapterXhtml({ title: label, heading, paragraphs: bodyParagraphs })
    );

    parts.push({ id, label, href });
  }

  // Title page (first page the reader sees).
  zip.file("OEBPS/title.xhtml", titlePageXhtml({ title: bookTitle, author }));

  // ── content.opf (package document) ──
  const manifestItems = parts
    .map(
      (p) =>
        `    <item id="${p.id}" href="${p.href}" media-type="application/xhtml+xml"/>`
    )
    .join("\n");

  const spineItems = parts
    .map((p) => `    <itemref idref="${p.id}"/>`)
    .join("\n");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${bookTitle}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:${generateUUID()}</dc:identifier>
    <dc:creator>${escapeXml(author ?? "Novel Translator")}</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`
  );

  // ── toc.ncx (older e-readers) ──
  const navPoints = parts
    .map(
      (p, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(p.label)}</text></navLabel>
      <content src="${p.href}"/>
    </navPoint>`
    )
    .join("\n");

  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${generateUUID()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${bookTitle}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`
  );

  // ── nav.xhtml (EPUB3) ──
  const navLiItems = parts
    .map((p) => `        <li><a href="${p.href}">${escapeXml(p.label)}</a></li>`)
    .join("\n");

  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
  <head>
    <title>Table of Contents</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Table of Contents</h1>
      <ol>
${navLiItems}
      </ol>
    </nav>
  </body>
</html>`
  );

  // Generate the EPUB (ZIP) file — level 1 DEFLATE for speed on phones.
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
  });

  return blob;
}

/** Trigger a browser download for a blob. */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── XHTML builders ────────────────────────────────────────────────

function chapterXhtml(opts: {
  title: string;
  heading: string;
  paragraphs: string[];
}): string {
  const { title, heading, paragraphs } = opts;
  const body = paragraphs.map((p) => `    <p>${escapeXml(p)}</p>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>${escapeXml(title)}</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; line-height: 1.7; margin: 2em; }
      p { margin: 0 0 1em 0; }
      h2 { font-size: 1.3em; margin: 0 0 1.2em 0; }
    </style>
  </head>
  <body>
    <section class="chapter">
${heading ? `      <h2>${escapeXml(heading)}</h2>\n` : ""}${body}
    </section>
  </body>
</html>`;
}

function titlePageXhtml(opts: { title: string; author?: string }): string {
  const { title, author } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>${title}</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; background: #fff; color: #111; margin: 0; padding: 0; text-align: center; }
      .cover { padding: 16vh 2.5em 0; }
      h1 { font-size: 1.9em; line-height: 1.35; margin: 0 0 0.5em; }
      .author { font-size: 1.15em; color: #333; margin: 0 0 2.2em; }
      .subtitle { font-size: 1.05em; color: #666; font-style: italic; margin: 0 0 1.6em; }
      .divider { color: #999; font-size: 1.1em; margin: 1.8em 0; }
      .meta { font-size: 0.8em; color: #888; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 3em; }
    </style>
  </head>
  <body>
    <div class="cover">
      <h1>${title}</h1>
      ${author ? `      <p class="author">${escapeXml(author)}</p>\n` : ""}
      <p class="subtitle">An English translation of a Chinese web novel</p>
      <div class="divider">&#10022;</div>
      <p class="meta">Translated with Novel Translator</p>
    </div>
  </body>
</html>`;
}

// ─── Text helpers ──────────────────────────────────────────────────

const HEADING_RE =
  /^(?:chapter\s+(?:\d+(?:[.:\-\s].*)?|[ivxlcdm]+)|第\s*[0-9一二三四五六七八九十百千万零]+\s*[章节卷回]|prologue|prolog|epilogue|epilog|interlude|prelude|楔子|序章|序言|番外|后记|尾声)/i;

function looksLikeHeading(line: string): boolean {
  return HEADING_RE.test(line.trim());
}

function shorten(text: string, max = 70): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

/** Best-effort author extraction from the translated front matter (e.g. "Author Ling Boyu"). */
function detectAuthor(texts: string[]): string | undefined {
  const haystack = texts.slice(0, 5).join("\n");
  const match = haystack.match(
    /(?:^|\n)\s*(?:author|written by|作者)\s*[:：\-]?\s*([A-Za-z][A-Za-z0-9 .'\-–—]{1,60})(?:\n|$)/im
  );
  if (!match) return undefined;
  const name = match[1].trim();
  return name.length > 0 ? name : undefined;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
