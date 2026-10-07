import { Copy } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { copyText } from "./copy-text";
import { Button, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { notify } = useWorkspace();
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Button
        small
        icon={Copy}
        onPress={() => {
          void copyText(text)
            .then(() => {
              setFailed(false);
              notify(`${label} 완료`);
            })
            .catch(() => setFailed(true));
        }}
      >
        {label}
      </Button>
      {failed && (
        <>
          <Text style={s.small}>
            자동 복사를 사용할 수 없습니다. 아래 내용을 선택해 복사하세요.
          </Text>
          <Field label={`복사할 내용 (${label})`} value={text} selectTextOnFocus multiline />
        </>
      )}
    </View>
  );
}
