/**
 * A photo from a phone, made small enough to keep.
 *
 * Phone cameras produce several megabytes; a receipt is readable at a fraction
 * of that, and every photo is carried in the database and its backups. So it is
 * redrawn here at a sensible size before it leaves the browser.
 */

const LONGEST_SIDE = 1600;

/** The photo as base64 JPEG. Rejects when the browser cannot read the file as a picture. */
export async function shrinkPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  // White behind it: a transparent PNG would otherwise turn black as a JPEG.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8).replace(/^data:[^,]*,/, '');
}
