import { encodeQr, qrToSvgPath, QR_QUIET_ZONE, type ErrorCorrectionLevel } from './encoder';

/**
 * Renders a payload as an inline SVG QR code.
 *
 * SVG rather than a canvas or a bitmap: it stays sharp on the counter tablet and
 * on paper, it prints without a second round trip, and it needs no client
 * JavaScript — the symbol is in the server-rendered HTML, so a customer never
 * waits for a script to draw the address they are about to send money to.
 *
 * The colours are fixed to black on white regardless of theme. A QR is read by a
 * camera expecting dark-on-light with a wide margin, and a scanner that fails at
 * the counter costs far more than a symbol that ignores dark mode.
 */
export function QrCode({
  value,
  size = 240,
  level = 'Q',
  className,
  title,
}: {
  value: string;
  /** Rendered edge length in pixels, quiet zone included. */
  size?: number;
  level?: ErrorCorrectionLevel;
  className?: string;
  /** Accessible name — screen readers cannot read the symbol itself. */
  title?: string;
}) {
  const matrix = encodeQr(value, { level });
  const extent = matrix.size + QR_QUIET_ZONE * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={title ?? value}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <g transform={`translate(${QR_QUIET_ZONE} ${QR_QUIET_ZONE})`}>
        <path d={qrToSvgPath(matrix)} fill="#000000" />
      </g>
    </svg>
  );
}
