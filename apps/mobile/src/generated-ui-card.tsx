import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { type GeneratedUi, parseGeneratedUi } from "../../../packages/domain/src/generative-ui";
import {
  generatedUiDocument,
  generatedUiWrapper,
} from "../../../packages/domain/src/generative-ui-document";
import { BrowserRunContext } from "./browser-tool-card";
import { GeneratedUiFrame, saveGeneratedUi } from "./generated-ui-frame";
import { themePalettes } from "./theme";
import { toolResultValue } from "./tool-result";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function GeneratedUiCard({
  args,
  result,
  loading,
}: {
  args: Record<string, unknown>;
  result: unknown;
  loading: boolean;
}) {
  const { ask } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  const receipt = toolResultValue(result) as { kind?: string; status?: string } | undefined;
  let complete: GeneratedUi | undefined;
  let invalid: string | undefined;
  if (receipt?.kind === "generated-ui" && receipt.status === "accepted") {
    try {
      complete = parseGeneratedUi(args);
    } catch {
      invalid = "저장된 시각화 형식이 올바르지 않습니다. AI에게 다시 만들어 달라고 요청하세요.";
    }
  }
  const generating = loading && active && !complete;
  const [channel] = useState(() => `ogui_${Math.random().toString(36).slice(2)}_${Date.now()}`);
  const [revision, setRevision] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [height, setHeight] = useState(360);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const title = typeof args.title === "string" ? args.title.slice(0, 120) : "대화형 시각화";
  // Throttle partial tool JSON updates; never execute partial JavaScript or
  // stopped/failed calls. The validated receipt unlocks the interactive frame.
  const next = complete ?? {
    html: typeof args.html === "string" ? args.html.slice(0, 64000) : "",
    css: typeof args.css === "string" ? args.css.slice(0, 24000) : "",
    initialHeight: typeof args.initialHeight === "number" ? args.initialHeight : 360,
  };
  const serialized = JSON.stringify(next);
  const latest = useRef(serialized);
  latest.current = serialized;
  const [preview, setPreview] = useState(serialized);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setPreview(latest.current), 500);
    return () => clearInterval(timer);
  }, [generating]);
  const content = generating ? preview : serialized;
  const ready = !!complete;
  const document = useMemo(
    () =>
      generatedUiDocument(JSON.parse(content), {
        channel,
        nonce: `${channel}_${revision}`,
        preview: !ready,
        dark: colors.canvas === themePalettes.dark.canvas,
      }),
    [content, channel, revision, ready, colors.canvas],
  );
  const hasHtml = Boolean(JSON.parse(content).html);
  async function download() {
    if (!complete) return;
    setSaving(true);
    try {
      await saveGeneratedUi(
        generatedUiWrapper(document, channel),
        `openmuse-${title.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 80)}.html`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "HTML을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card style={{ gap: 12, padding: 14 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={s.heading}>{title}</Text>
        <Text style={s.small}>
          {generating ? "화면 생성 중…" : complete ? "대화형 화면" : "미완성 미리보기"}
        </Text>
      </View>
      <ErrorNotice error={invalid || error} />
      {!hidden && hasHtml && (
        <GeneratedUiFrame
          document={document}
          channel={channel}
          title={title}
          height={Math.max(200, Math.min(expanded ? 1200 : 680, height))}
          onMessage={(message) => {
            if (message.type === "height") setHeight(message.height);
            else if (message.type === "error") setError(message.message);
            else if (message.type === "prompt" && complete) setDraft(message.text);
          }}
        />
      )}
      {!hasHtml && (
        <Text style={s.muted}>
          {generating
            ? "설명에 맞는 화면을 구성하고 있습니다."
            : "화면 생성을 마치지 못했습니다. 다시 요청해 주세요."}
        </Text>
      )}
      {!!draft && (
        <View style={{ gap: 8 }}>
          <Text style={s.label}>이 화면에서 이어서 질문</Text>
          <Text selectable style={s.text}>
            {draft}
          </Text>
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              onPress={() => {
                ask(draft);
                setDraft(undefined);
              }}
            >
              채팅에 보내기
            </Button>
            <Button small onPress={() => setDraft(undefined)}>
              취소
            </Button>
          </View>
        </View>
      )}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {complete && (
          <Button small disabled={saving} onPress={() => void download()}>
            {saving ? "저장 중…" : "HTML 다운로드"}
          </Button>
        )}
        {hasHtml && (
          <Button small onPress={() => setHidden(!hidden)}>
            {hidden ? "화면 보기" : "화면 접기"}
          </Button>
        )}
        {hasHtml && !hidden && (
          <Button small onPress={() => setExpanded(!expanded)}>
            {expanded ? "기본 크기" : "크게 보기"}
          </Button>
        )}
        {complete && (
          <Button
            small
            onPress={() => {
              setRevision(revision + 1);
              setError(undefined);
              setDraft(undefined);
            }}
          >
            초기화
          </Button>
        )}
      </View>
    </Card>
  );
}
