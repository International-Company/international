/**
 * A receipt as a file, drawn in the browser.
 *
 * ## Why not on the server
 *
 * For the reason the print pages already give: Arabic needs bidirectional
 * ordering and contextual letter shaping, and most server-side PDF libraries
 * mangle both — producing a document that looks like Arabic to somebody who
 * cannot read it. The browser's text engine does it correctly because it has
 * to, so the drawing happens where the engine is.
 *
 * ## Why it is drawn rather than captured
 *
 * Capturing the printable page would need a screenshot library and would still
 * be a second layout able to drift from the first. This renders the *same
 * composed text* the share menu sends — one source for what a receipt says,
 * two presentations of it — so the file and the message can never disagree
 * about a figure.
 *
 * ## Why a picture inside a PDF
 *
 * Embedding real text would mean embedding a font that shapes Arabic, and
 * subsetting one correctly is a project. A page-sized image is honest about
 * what it is: something to look at, print and forward. The searchable copy is
 * the transaction itself, which never left the office.
 */

/** Any Arabic letter, which is enough to decide a run's direction. */
const ARABIC = /[؀-ۿݐ-ݿ]/;

/** A4 at 150dpi, and the same page in the points a PDF measures in. */
const PAGE = { width: 1240, height: 1754 };
const POINTS = { width: 595, height: 842 };

export interface ReceiptDocument {
  companyName: string;
  reference: string;
  /** The composed lines, exactly as the share text carries them. */
  text: string;
}

/** Draws the receipt and returns it as a one-page PDF. */
export async function receiptPdf(doc: ReceiptDocument): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE.width;
  canvas.height = PAGE.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the receipt');

  // The page's own face, so the file looks like the screen it came from.
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  await document.fonts?.ready;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, PAGE.width, PAGE.height);

  ctx.direction = 'rtl';
  ctx.textBaseline = 'alphabetic';

  const margin = 90;
  const right = PAGE.width - margin;
  const left = margin;
  let y = 150;

  // --- The letterhead ------------------------------------------------------
  const all = doc.text.split('\n');
  const heading = all[0] ?? '';
  const body = all.slice(1);
  const title = doc.companyName || heading;

  ctx.fillStyle = '#0F1523';
  ctx.font = `700 46px ${family}`;
  ctx.textAlign = 'center';
  ctx.fillText(title, PAGE.width / 2, y);
  y += 34;

  ctx.strokeStyle = '#D5DCE9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 70;

  /*
   * The composed lines. A blank one is a gap the composer put there on
   * purpose, and a `label: value` becomes two columns so the figures line up
   * down the page rather than trailing their labels.
   */
  const raw: string[] = title === heading ? body : [heading, ...body];
  const lines = raw.filter(
    (line, index) =>
      !(index === 0 && line.trim() === '') &&
      !(line.trim() === '' && (raw[index - 1] ?? '').trim() === ''),
  );

  for (const line of lines) {
    if (line.trim() === '') {
      y += 26;
      continue;
    }

    const split = line.indexOf(': ');
    if (split > 0) {
      const label = line.slice(0, split);
      const value = line.slice(split + 2);

      ctx.textAlign = 'right';
      ctx.fillStyle = '#5B6579';
      ctx.font = `400 30px ${family}`;
      ctx.fillText(label, right, y);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#0F1523';
      ctx.font = `600 32px ${family}`;
      /*
       * Each value in its own direction.
       *
       * A reference or an amount is a Latin run and reads left to right even on
       * an Arabic page. A value with Arabic in it does not — and forcing one to
       * does real damage rather than cosmetic: "19 أغسطس 2026" drawn left to
       * right comes out as "أغسطس 2026 19", with the day at the far end, which
       * is a date nobody would read the way it was meant.
       */
      ctx.direction = ARABIC.test(value) ? 'rtl' : 'ltr';
      ctx.fillText(value, left, y);
      ctx.direction = 'rtl';
    } else {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#0F1523';
      ctx.font = `700 34px ${family}`;
      ctx.fillText(line, right, y);
    }

    y += 52;
    if (y > PAGE.height - 160) break;
  }

  // --- The footer ----------------------------------------------------------
  ctx.strokeStyle = '#E8EDF6';
  ctx.beginPath();
  ctx.moveTo(left, PAGE.height - 120);
  ctx.lineTo(right, PAGE.height - 120);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#7B8598';
  ctx.font = `400 24px ${family}`;
  ctx.fillText(doc.reference, PAGE.width / 2, PAGE.height - 70);

  const jpeg = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The receipt could not be drawn'))),
      'image/jpeg',
      0.92,
    );
  });

  return wrapInPdf(new Uint8Array(await jpeg.arrayBuffer()));
}

/**
 * The smallest PDF that can hold one picture.
 *
 * Five objects: the catalogue, the page tree, the page, its content stream and
 * the image itself. The JPEG goes in untouched — `DCTDecode` means "this
 * stream is already a JPEG" — so nothing re-encodes it and the file is barely
 * larger than the picture.
 */
function wrapInPdf(jpeg: Uint8Array): Blob {
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: string | Uint8Array) => {
    parts.push(chunk);
    length += typeof chunk === 'string' ? new TextEncoder().encode(chunk).length : chunk.length;
  };
  const object = (body: string) => {
    offsets.push(length);
    push(body);
  };

  push('%PDF-1.4\n');

  object('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  object('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  object(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${POINTS.width} ${POINTS.height}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  );

  const draw = `q ${POINTS.width} 0 0 ${POINTS.height} 0 0 cm /Im0 Do Q`;
  object(`4 0 obj\n<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`);

  offsets.push(length);
  push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${PAGE.width} /Height ${PAGE.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');

  const xref = length;
  let table = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
