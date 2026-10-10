import { useEffect, useRef } from "react";
import { generatedUiMessageSchema } from "../../../packages/domain/src/generative-ui";
import type { GeneratedUiFrameProps } from "./generated-ui-frame-types";

export function GeneratedUiFrame({
  document,
  channel,
  title,
  height,
  onMessage,
}: GeneratedUiFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const callback = useRef(onMessage);
  callback.current = onMessage;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.channel !== channel
      )
        return;
      const parsed = generatedUiMessageSchema.safeParse(event.data);
      if (parsed.success) callback.current(parsed.data);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);
  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      style={{ width: "100%", height, border: 0, borderRadius: 12, background: "transparent" }}
    />
  );
}

export async function saveGeneratedUi(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
