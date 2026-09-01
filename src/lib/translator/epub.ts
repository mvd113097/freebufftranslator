import JSZip from "jszip";

/**
 * Generate a valid EPUB file from translated text chunks.
 * Each chunk becomes a separate chapter (XHTML).
 */
export async function generateEpub(
  chunks: { index: number; text: string }[],
  title: string,
  fileName: string,
): Promise<Blob> {
  const zip = new JSZip();

  // Sanitize title for XML
  const safeTitle = title.replace(/[<>&'"]/g, (c) => {
    const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[c] || c;
  });

  // EPUB requires this exact string, uncompressed
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

  // Build chapters
  const chapters: { id: string; title: string; href: string }[] = [];
  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i];
    const chapterId = `chapter_${String(i + 1).padStart(3, "0")}`;
    const chapterHref = `${chapterId}.xhtml`;
    const chapterTitle = `Chapter ${i + 1}`;

    // Convert text to XHTML with proper paragraph spacing
    const paragraphs = chunk.text
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > 0);

    const content = paragraphs
      .map((p) => `      <p>${escapeXml(p.trim())}</p>`)
      .join("\n");

    zip.file(
      `OEBPS/${chapterHref}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>${chapterTitle}</title>
    <style>
      body { font-family: Georgia, serif; line-height: 1.6; margin: 2em; }
      p { margin: 0 0 1em 0; text-indent: 0; }
    </style>
  </head>
  <body>
    <h2>${chapterTitle}</h2>
${content}
  </body>
</html>`
    );

    chapters.push({ id: chapterId, title: chapterTitle, href: chapterHref });
  }

  // content.opf (package document)
  const manifestItems = chapters
    .map((ch) => `    <item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`)
    .join("\n");

  const spineItems = chapters
    .map((ch) => `    <itemref idref="${ch.id}"/>`)
    .join("\n");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:${generateUUID()}</dc:identifier>
    <dc:creator>Novel Translator</dc:creator>
    <dc:description>Translated from Chinese to English by Novel Translator</dc:description>
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

  // toc.ncx (for older e-readers)
  const navPoints = chapters
    .map(
      (ch, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.href}"/>
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
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`
  );

  // Navigation document (EPUB3)
  const navLiItems = chapters
    .map((ch) => `        <li><a href="${ch.href}">${ch.title}</a></li>`)
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

  // Generate the EPUB (ZIP) file
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return blob;
}

/**
 * Trigger a browser download for a blob.
 */
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
