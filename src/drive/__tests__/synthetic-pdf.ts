/**
 * A minimal, valid PDF with one text line per page, built by hand so the tests
 * run the real unpdf / pdf.js on a synthetic file (no real document anywhere).
 */
export function buildPdf(pages: string[]): Uint8Array {
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const bodies: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
  ];
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const content = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
