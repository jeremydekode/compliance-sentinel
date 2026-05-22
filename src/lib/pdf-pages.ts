/**
 * Deterministic per-page text extraction for PDF buffers.
 * Used to anchor chunker output to real page numbers instead of letting
 * the LLM guess. Returns one entry per page in document order.
 *
 * Uses `unpdf` — a serverless-safe PDF library that ships its own pdfjs build
 * with the browser globals (DOMMatrix etc.) polyfilled, so it runs in the
 * Vercel Node runtime where bare pdfjs-dist crashes ("DOMMatrix is not
 * defined"). Imported lazily to keep the pdf chain out of cold-start.
 */
export async function extractPdfPages(
  buffer: Buffer
): Promise<Array<{ page: number; text: string }>> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((t, i) => ({ page: i + 1, text: String(t ?? "").trim() }));
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
