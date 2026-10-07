/** Keep the selection inside the active modal's focus boundary, including on HTTP hosts. */
function legacyCopy(text: string) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("aria-label", "클립보드 복사 중");
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px";
  const modal =
    previous?.closest('[aria-modal="true"], [role="dialog"]') ??
    Array.from(document.querySelectorAll('[aria-modal="true"], [role="dialog"]')).at(-1);
  (modal ?? previous?.parentElement ?? document.body).appendChild(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("클립보드 복사가 허용되지 않았습니다.");
  } finally {
    input.remove();
    previous?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* HTTP/permissions fallback below. */
    }
  }
  legacyCopy(text);
}
