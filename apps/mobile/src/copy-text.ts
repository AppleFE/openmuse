import * as Clipboard from "expo-clipboard";

export async function copyText(text: string) {
  if (!(await Clipboard.setStringAsync(text)))
    throw new Error("클립보드 복사가 허용되지 않았습니다.");
}
