/**
 * Stitch translated chunks and export as an .epub file.
 * Uses a minimal EPUB structure (XHTML content wrapped in EPUB zip).
 */

export function stitchAndExportEpub(
  translatedChunks: string[],
  originalText: string,
  title: string,
): void {
  // Filter out empty chunks
  const translated = translatedChunks.filter((c) => c.length > 0);
  if (translated.length === 0) {
    throw new Error("No translated content to export");
  }

  // Create XHTML content from chunks
  const xhtmlContent = translated
    .map((chunk, i) => {
      const paragraphs = chunk
        .split(/\n+/)
        .filter((p) => p.trim().length > 0)
        .map((p) => `<p>${escapeXml(p.trim())}</p>`)
        .join("\n        ");
      return `    <div class="chapter" id="chapter-${i + 1}">
      <h2>Chapter ${i + 1}</h2>
      ${paragraphs}
    </div>`;
    })
    .join("\n");

  // Build the full XHTML document
  const xhtmlDoc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; line-height: 1.8; margin: 2em; }
    h1 { text-align: center; margin-bottom: 2em; font-size: 1.8em; }
    h2 { font-size: 1.2em; margin-top: 2em; color: #666; }
    p { text-indent: 1.5em; margin: 0.5em 0; }
    .chapter { page-break-before: always; }
    .chapter:first-child { page-break-before: avoid; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
${xhtmlContent}
</body>
</html>`;

  // Create a minimal EPUB structure as a single XHTML file
  // For maximum compatibility, we'll create an .epub that's really a zipped XHTML
  const content = buildMinimalEpub(title, xhtmlDoc);

  // Create blob and download
  const blob = new Blob([content], { type: "application/epub+zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(title)}.epub`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

/**
 * Build a minimal EPUB file using JSZip-compatible manual ZIP construction.
 * We include container.xml, content.opf, and the XHTML content.
 */
function buildMinimalEpub(title: string, xhtmlContent: string): ArrayBuffer {
  // Simple ZIP file creation without any external dependencies
  const encoder = new TextEncoder();

  const files: Array<{ name: string; data: Uint8Array }> = [];

  // mimetype (must be first, uncompressed)
  files.push({
    name: "mimetype",
    data: encoder.encode("application/epub+zip"),
  });

  // META-INF/container.xml
  files.push({
    name: "META-INF/container.xml",
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  });

  // content.opf
  files.push({
    name: "content.opf",
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="id">novel-translator-${Date.now()}</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`),
  });

  // nav.xhtml
  files.push({
    name: "nav.xhtml",
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol><li><a href="chapter1.xhtml">${escapeXml(title)}</a></li></ol>
  </nav>
</body>
</html>`),
  });

  // toc.xhtml (simple fallback)
  files.push({
    name: "toc.xhtml",
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Table of Contents</title></head>
<body>
  <h1>${escapeXml(title)}</h1>
  <p><a href="chapter1.xhtml">Read Novel</a></p>
</body>
</html>`),
  });

  // chapter1.xhtml (the actual content)
  files.push({
    name: "chapter1.xhtml",
    data: encoder.encode(xhtmlContent),
  });

  return createZipBuffer(files);
}

/**
 * Create a minimal ZIP file buffer without any external library.
 * Supports stored (no compression) entries.
 */
function createZipBuffer(
  files: Array<{ name: string; data: Uint8Array }>,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  const localHeaders: Uint8Array[] = [];

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const localHeader = new ArrayBuffer(30 + nameBytes.length + file.data.length);
    const view = new DataView(localHeader);

    // Local file header signature
    view.setUint32(0, 0x04034b50, true);
    // Version needed to extract
    view.setUint16(4, 20, true);
    // General purpose bit flag (0)
    view.setUint16(6, 0, true);
    // Compression method (0 = stored)
    view.setUint16(8, 0, true);
    // Last mod time/date
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    // CRC-32
    view.setUint32(14, crc32(file.data), true);
    // Compressed size
    view.setUint32(18, file.data.length, true);
    // Uncompressed size
    view.setUint32(22, file.data.length, true);
    // File name length
    view.setUint16(26, nameBytes.length, true);
    // Extra field length
    view.setUint16(28, 0, true);

    // Copy name and data
    const headerArray = new Uint8Array(localHeader);
    headerArray.set(nameBytes, 30);
    headerArray.set(file.data, 30 + nameBytes.length);

    localHeaders.push(headerArray);

    // Central directory entry
    const cdEntry = new ArrayBuffer(46 + nameBytes.length);
    const cdView = new DataView(cdEntry);

    // Central directory header signature
    cdView.setUint32(0, 0x02014b50, true);
    // Version made by
    cdView.setUint16(4, 20, true);
    // Version needed
    cdView.setUint16(6, 20, true);
    // Flags
    cdView.setUint16(8, 0, true);
    // Compression method
    cdView.setUint16(10, 0, true);
    // Time/date
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    // CRC-32
    cdView.setUint32(16, crc32(file.data), true);
    // Compressed size
    cdView.setUint32(20, file.data.length, true);
    // Uncompressed size
    cdView.setUint32(24, file.data.length, true);
    // Name length
    cdView.setUint16(28, nameBytes.length, true);
    // Extra length
    cdView.setUint16(30, 0, true);
    // Comment length
    cdView.setUint16(32, 0, true);
    // Disk number start
    cdView.setUint16(34, 0, true);
    // Internal attributes
    cdView.setUint16(36, 0, true);
    // External attributes
    cdView.setUint32(38, 0, true);
    // Offset to local header
    cdView.setUint32(42, offset, true);

    const cdArray = new Uint8Array(cdEntry);
    cdArray.set(nameBytes, 46);

    centralDirectory.push(cdArray);
    offset += localHeader.byteLength;
  }

  // End of central directory record
  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDirectory) cdSize += cd.length;

  const eocd = new ArrayBuffer(22);
  const eocdView = new DataView(eocd);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  // Combine everything
  const totalSize = offset + cdSize + 22;
  const buffer = new ArrayBuffer(totalSize);
  const result = new Uint8Array(buffer);

  let pos = 0;
  for (const header of localHeaders) {
    result.set(header, pos);
    pos += header.length;
  }
  for (const cd of centralDirectory) {
    result.set(cd, pos);
    pos += cd.length;
  }
  result.set(new Uint8Array(eocd), pos);

  return buffer;
}

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
