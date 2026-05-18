import { PDFParse } from "pdf-parse";

/**
 * Deterministic per-page text extraction for PDF buffers.
 * Used to anchor chunker output to real page numbers instead of letting
 * the LLM guess. Returns one entry per page in document order.
 */
export async function extractPdfPages(
  buffer: Buffer
): Promise<Array<{ page: number; text: string }>> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({
      page: p.num,
      text: (p.text ?? "").trim(),
    }));
  } finally {
    // PDFParse holds the underlying pdfjs document open
    try { await (parser as any).destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Build a single text blob with explicit page markers the LLM can use
 * as ground truth when emitting per-chunk page numbers.
 */
export function pagesToMarkedText(
  pages: Array<{ page: number; text: string }>
): string {
  return pages
    .filter((p) => p.text.length > 0)
    .map((p) => `=== PAGE ${p.page} ===\n${p.text}`)
    .join("\n\n");
}
