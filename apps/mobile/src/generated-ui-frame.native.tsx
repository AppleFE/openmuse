import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useMemo } from "react";
import { WebView } from "react-native-webview";
import { generatedUiMessageSchema } from "../../../packages/domain/src/generative-ui";
import { generatedUiWrapper } from "../../../packages/domain/src/generative-ui-document";
import type { GeneratedUiFrameProps } from "./generated-ui-frame-types";

export function GeneratedUiFrame({
  document,
  channel,
  title,
  height,
  onMessage,
}: GeneratedUiFrameProps) {
  const source = useMemo(
    () => ({ html: generatedUiWrapper(document, channel, true) }),
    [document, channel],
  );
  return (
    <WebView
      source={source}
      accessibilityLabel={title}
      style={{ height, backgroundColor: "transparent" }}
      javaScriptEnabled
      originWhitelist={["about:*"]}
      domStorageEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowFileAccess={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" || request.url === "about:srcdoc"
      }
      onMessage={(event) => {
        try {
          const data: unknown = JSON.parse(event.nativeEvent.data);
          if (!data || typeof data !== "object" || !("channel" in data) || data.channel !== channel)
            return;
          const parsed = generatedUiMessageSchema.safeParse(data);
          if (parsed.success) onMessage(parsed.data);
        } catch {
          /* Ignore non-protocol messages from generated content. */
        }
      }}
    />
  );
}

export async function saveGeneratedUi(html: string, filename: string) {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("이 기기에서는 파일 공유를 사용할 수 없습니다.");
  const uri = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, html, { encoding: FileSystem.EncodingType.UTF8 });
  try {
    await Sharing.shareAsync(uri, { mimeType: "text/html", UTI: "public.html" });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}
