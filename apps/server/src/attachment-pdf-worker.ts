import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const {
  data,
  page: start,
  limit,
  offset,
} = workerData as { data: Uint8Array; page: number; limit: number; offset: number };
const loading = getDocument({
  data,
  disableFontFace: true,
  useSystemFonts: false,
  standardFontDataUrl: fileURLToPath(
    new URL("../../standard_fonts/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")),
  ).replace(/\\/g, "/"),
  stopAtErrors: true,
});
try {
  const doc = await loading.promise;
  let text = "";
  if (start <= doc.numPages) {
    const pdfPage = await doc.getPage(start);
    const content = await pdfPage.getTextContent();
    text = content.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
      .join("");
    pdfPage.cleanup();
  }
  const more = offset + limit < text.length;
  parentPort?.postMessage({
    text: text.slice(offset, offset + limit),
    page: start,
    pageCount: doc.numPages,
    nextPage: more ? start : start < doc.numPages ? start + 1 : null,
    nextOffset: more ? offset + limit : 0,
    note: "PDF 텍스트 추출입니다. 스캔 이미지와 도표를 OCR하지 않습니다.",
  });
} catch {
  parentPort?.postMessage({
    error: "PDF의 텍스트를 읽을 수 없습니다. 암호화되었거나 손상된 파일인지 확인하세요.",
  });
} finally {
  await loading.destroy();
}
