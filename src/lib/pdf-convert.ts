// ============================================================================
// docx → PDF via CloudConvert (server-only). Used to produce an EXACT preview
// of a document: CloudConvert renders with a real Office engine, so the PDF is
// faithful to Word (EMF logos, tables, fonts) in a way docx-preview can't be.
// The PDF is then rendered in-app with pdf.js (which we control — so click-to-
// jump + highlight still work, unlike an external viewer iframe).
// ============================================================================

const CC_BASE = "https://api.cloudconvert.com/v2";

/**
 * Converts a publicly-reachable .docx URL to a PDF, returning the PDF bytes.
 * Throws with a readable message on any CloudConvert failure so the caller can
 * surface it. Requires CLOUDCONVERT_API_KEY in the environment.
 */
export async function convertDocxToPdf(fileUrl: string): Promise<Buffer> {
  const key = process.env.CLOUDCONVERT_API_KEY;
  if (!key) throw new Error("Exact PDF view isn't configured (missing CLOUDCONVERT_API_KEY).");

  // One job: import the docx by URL → convert to PDF → export a download URL.
  const jobResp = await fetch(`${CC_BASE}/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tasks: {
        imp: { operation: "import/url", url: fileUrl },
        conv: { operation: "convert", input: "imp", output_format: "pdf" },
        exp: { operation: "export/url", input: "conv" },
      },
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job: any = await jobResp.json();
  if (!job?.data?.id) throw new Error(`Conversion could not start: ${job?.message ?? `HTTP ${jobResp.status}`}`);

  // Long-poll until the job finishes (typical: a few seconds).
  const waitResp = await fetch(`${CC_BASE}/jobs/${job.data.id}/wait`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const done: any = (await waitResp.json())?.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exp = done?.tasks?.find((t: any) => t.name === "exp");
  const url = exp?.result?.files?.[0]?.url;
  if (exp?.status !== "finished" || !url) {
    throw new Error(`PDF conversion failed: ${exp?.message ?? done?.status ?? "unknown error"}`);
  }

  const pdfResp = await fetch(url);
  if (!pdfResp.ok) throw new Error(`Could not download the converted PDF (${pdfResp.status}).`);
  return Buffer.from(await pdfResp.arrayBuffer());
}
