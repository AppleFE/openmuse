import { BookOpen, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  knowledgeLimits,
  pinnedCharacters,
  type ThreadKnowledge,
  threadKnowledgeSchema,
} from "../../../packages/domain/src/thread-knowledge";
import { AssistantResponse } from "./assistant-response";
import { useMuseThread } from "./threads";
import { Button, Card, CheckRow, colors, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ChatNotebook({
  threadId,
  active,
  replying,
}: {
  threadId: string;
  active: boolean;
  replying: boolean;
}) {
  const { api } = useWorkspace();
  const { refetch, mainId } = useMuseThread();
  const [knowledge, setKnowledge] = useState<ThreadKnowledge>(),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const path = `/api/copilotkit/threads/${encodeURIComponent(threadId)}/knowledge`;
  const load = useCallback(async () => {
    const value = await api.request<ThreadKnowledge>(path);
    setKnowledge(value);
    setError("");
    return value;
  }, [api, path]);
  useEffect(() => {
    if (active && !replying) void load().catch((e) => setError(String(e.message ?? e)));
  }, [active, replying, load]);
  return (
    <>
      <View style={[s.row, { gap: 8, paddingVertical: 6 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {!!knowledge?.category && (
            <Text numberOfLines={1} style={s.small}>
              {knowledge.category}
            </Text>
          )}
          {!!knowledge?.issue && (
            <Text numberOfLines={1} style={s.small}>
              {knowledge.issue}
            </Text>
          )}
        </View>
        <Button
          small
          icon={BookOpen}
          onPress={() => {
            void load()
              .then(() => setOpen(true))
              .catch((e) => {
                setError(String(e.message ?? e));
                setOpen(true);
              });
          }}
        >
          메모·문서{knowledge?.documents.length ? ` ${knowledge.documents.length}` : ""}
        </Button>
      </View>
      {open &&
        (knowledge ? (
          <NotebookEditor
            key={threadId}
            initial={knowledge}
            title={threadId === mainId ? "기본 채팅 메모·문서" : "이 채팅의 메모·문서"}
            onClose={() => setOpen(false)}
            reload={load}
            save={async (value) => {
              const saved = await api.request<ThreadKnowledge>(path, value, "PUT");
              setKnowledge(saved);
              refetch();
              return saved;
            }}
          />
        ) : (
          <Sheet title="채팅 메모·문서" onClose={() => setOpen(false)}>
            <ErrorNotice error={error} />
            <Button onPress={() => void load().catch((e) => setError(String(e.message ?? e)))}>
              다시 불러오기
            </Button>
          </Sheet>
        ))}
    </>
  );
}

function NotebookEditor({
  initial,
  title,
  onClose,
  reload,
  save,
}: {
  initial: ThreadKnowledge;
  title: string;
  onClose: () => void;
  reload: () => Promise<ThreadKnowledge>;
  save: (value: ThreadKnowledge) => Promise<ThreadKnowledge>;
}) {
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string>(),
    [preview, setPreview] = useState(false),
    [confirmReload, setConfirmReload] = useState(false),
    [closing, setClosing] = useState(false);
  const doc = draft.documents.find((d) => d.id === selected),
    dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  function patch(value: Partial<ThreadKnowledge>) {
    setDraft((old) => ({ ...old, ...value }));
    setNotice("");
  }
  function editDocument(value: Partial<ThreadKnowledge["documents"][number]>) {
    patch({ documents: draft.documents.map((d) => (d.id === selected ? { ...d, ...value } : d)) });
  }
  async function persist() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = threadKnowledgeSchema.safeParse(draft);
      if (!result.success) throw Error(result.error.issues.map((i) => i.message).join("\n"));
      const next = await save(result.data);
      setDraft(next);
      setSaved(next);
      setNotice("저장했습니다. 다음 답변부터 이 채팅의 AI가 참고합니다.");
      setConfirmReload(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (dirty && !confirmReload) {
      setConfirmReload(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await reload();
      setDraft(next);
      setSaved(next);
      setConfirmReload(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={title}
      subtitle="이 채팅에서 사용할 정보와 참고 문서를 저장하세요."
      onClose={() => {
        if (busy) return;
        if (dirty) setClosing(true);
        else onClose();
      }}
    >
      <View style={{ gap: 16 }}>
        {closing && (
          <Card>
            <Text style={s.text}>저장하지 않은 변경 사항이 있습니다.</Text>
            <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
              <Button small onPress={() => setClosing(false)}>
                계속 편집
              </Button>
              <Button small danger onPress={onClose}>
                저장하지 않고 닫기
              </Button>
            </View>
          </Card>
        )}
        <Text style={s.small}>
          주요 메모와 고정 문서는 매 답변에 전달됩니다. 다른 채팅과 공유되지 않으며, 긴 참고 문서는
          필요한 부분을 AI가 읽습니다.
        </Text>
        <Field
          label="카테고리"
          placeholder="예: 홈서버, PBAI, 업무"
          value={draft.category}
          maxLength={80}
          editable={!busy}
          onChangeText={(category) => patch({ category })}
        />
        <Field
          label="이슈·주제"
          placeholder="예: Proxmox 스토리지 확장 / 이슈 #42"
          value={draft.issue}
          maxLength={200}
          editable={!busy}
          onChangeText={(issue) => patch({ issue })}
        />
        <Field
          label="주요 메모 (항상 참고)"
          placeholder={
            "IP: 192.168.0.10\n접속: ssh user@server -p 22\n프로젝트 위치: /srv/project\n주의할 점과 작업 목표"
          }
          multiline
          value={draft.notes}
          maxLength={6000}
          editable={!busy}
          onChangeText={(notes) => patch({ notes })}
          style={{ minHeight: 170, maxHeight: 320 }}
        />
        <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
          <Text style={s.heading}>
            참고 문서 {draft.documents.length}/{knowledgeLimits.documents}
          </Text>
          <Button
            small
            icon={Plus}
            disabled={busy || draft.documents.length >= knowledgeLimits.documents}
            onPress={() => {
              const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
              patch({
                documents: [
                  ...draft.documents,
                  { id, title: "새 문서", content: "", pinned: false },
                ],
              });
              setSelected(id);
              setPreview(false);
            }}
          >
            문서 추가
          </Button>
        </View>
        {draft.documents.map((d) => (
          <Pressable
            key={d.id}
            accessibilityRole="button"
            accessibilityLabel={`참고 문서 편집: ${d.title}`}
            disabled={busy}
            onPress={() => {
              setSelected(d.id);
              setPreview(false);
            }}
            style={{
              padding: 14,
              borderRadius: 16,
              backgroundColor: selected === d.id ? colors.sky : colors.surfaceMuted,
              gap: 4,
            }}
          >
            <Text style={s.text}>{d.title || "제목 없는 문서"}</Text>
            <Text style={s.small}>
              {d.pinned ? "고정 · 항상 참고" : "필요할 때 읽기"} ·{" "}
              {d.content.length.toLocaleString()}자
            </Text>
          </Pressable>
        ))}
        {doc && (
          <Card style={{ gap: 12 }}>
            <Field
              label="문서 제목"
              value={doc.title}
              maxLength={120}
              editable={!busy}
              onChangeText={(title) => editDocument({ title })}
            />
            <CheckRow
              label="이 문서 고정 (항상 참고)"
              checked={doc.pinned}
              onPress={() => {
                if (!busy) editDocument({ pinned: !doc.pinned });
              }}
            />
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button small onPress={() => setPreview(!preview)}>
                {preview ? "문서 편집" : "미리보기"}
              </Button>
              <Button
                small
                danger
                icon={Trash2}
                disabled={busy}
                onPress={() => {
                  patch({ documents: draft.documents.filter((d) => d.id !== doc.id) });
                  setSelected(undefined);
                }}
              >
                문서 삭제
              </Button>
            </View>
            {preview ? (
              <AssistantResponse content={doc.content || "내용이 없습니다."} />
            ) : (
              <Field
                label="문서 내용"
                placeholder="접속 방법, 구성, 작업 기록 등을 Markdown이나 일반 텍스트로 작성하세요."
                multiline
                value={doc.content}
                maxLength={knowledgeLimits.documentCharacters}
                editable={!busy}
                onChangeText={(content) => editDocument({ content })}
                style={{ minHeight: 220, maxHeight: 400 }}
              />
            )}
          </Card>
        )}
        <Text style={s.small}>
          항상 참고할 내용 {pinnedCharacters(draft).toLocaleString()}/12,000자 · 문서당 40,000자.
          추가·수정·삭제는 저장할 때 반영됩니다.
        </Text>
        <ErrorNotice error={error} />
        {!!notice && (
          <Text accessibilityLiveRegion="polite" style={s.text}>
            {notice}
          </Text>
        )}
        {confirmReload && (
          <Text style={s.small}>
            다시 누르면 저장하지 않은 변경을 버리고 최신 내용을 불러옵니다.
          </Text>
        )}
        <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
          <Button primary busy={busy} disabled={!dirty} onPress={() => void persist()}>
            메모·문서 저장
          </Button>
          <Button disabled={busy} onPress={() => void refresh()}>
            {confirmReload ? "변경을 버리고 불러오기" : "최신 내용 불러오기"}
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
