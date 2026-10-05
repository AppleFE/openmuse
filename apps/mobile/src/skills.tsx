import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { BookOpen, FolderOpen, Upload } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { SkillInfo } from "../../../packages/domain/src/skills";
import { API_URL } from "./api";
import { Button, Card, CheckRow, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function useSkills() {
  const { api } = useWorkspace();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSkills((await api.request<{ skills: SkillInfo[] }>("/api/skills")).skills);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { skills, error, refresh };
}

export function skillSuggestions(skills: SkillInfo[], draft: string) {
  const match = /^\/(?:skill:)?([a-z0-9-]*)$/.exec(draft);
  return match ? skills.filter((s) => s.enabled && s.name.startsWith(match[1])).slice(0, 6) : [];
}

export function SkillSuggestions({
  skills,
  draft,
  onSelect,
  onManage,
}: {
  skills: SkillInfo[];
  draft: string;
  onSelect: (name: string) => void;
  onManage: () => void;
}) {
  if (!/^\/(?:skill:)?[a-z0-9-]*$/.test(draft)) return null;
  const matches = skillSuggestions(skills, draft);
  return (
    <Card style={{ padding: 12, gap: 6, marginBottom: 8 }}>
      <View style={s.between}>
        <Text style={s.heading}>스킬 선택</Text>
        <Button small onPress={onManage}>
          스킬 관리
        </Button>
      </View>
      <ScrollView style={{ maxHeight: 210 }} keyboardShouldPersistTaps="handled">
        {matches.map((skill) => (
          <Pressable
            key={skill.id}
            accessibilityRole="button"
            accessibilityLabel={`스킬 선택: ${skill.name}`}
            onPress={() => onSelect(skill.name)}
            style={({ pressed }) => ({
              padding: 9,
              borderRadius: 10,
              backgroundColor: pressed ? colors.sky : "transparent",
              gap: 2,
            })}
          >
            <Text style={s.text}>/{skill.name}</Text>
            <Text style={s.small} numberOfLines={1}>
              {skill.description}
            </Text>
          </Pressable>
        ))}
        {!matches.length && (
          <Text style={s.muted}>일치하는 스킬이 없습니다. 스킬 관리에서 추가하세요.</Text>
        )}
      </ScrollView>
      <Text style={s.small}>
        선택 후 요청을 입력하세요. Tab으로 첫 번째 스킬을 선택할 수 있습니다.
      </Text>
    </Card>
  );
}

async function webFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    else input.accept = ".md,.zip,.skill,.tar,.gz,.tgz";
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.onchange = () => done(Array.from(input.files ?? []));
    input.oncancel = () => done([]);
    input.click();
  });
}

export function SkillsManager({
  onClose,
  onUse,
}: {
  onClose: () => void;
  onUse?: (name: string) => void;
}) {
  const { api } = useWorkspace(),
    { skills, error: loadError, refresh } = useSkills();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [replace, setReplace] = useState(false);
  const [detail, setDetail] = useState<{ skill: SkillInfo; instructions: string }>(),
    [deleting, setDeleting] = useState<string>();
  async function upload(folder = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let result: { skills: SkillInfo[] };
      if (Platform.OS === "web") {
        const files = await webFiles(folder);
        if (!files.length) return;
        if (files.length > 512 || files.reduce((n, f) => n + f.size, 0) > 10 * 1024 * 1024)
          throw Error("한 번에 512개 파일, 합계 10MB까지 업로드할 수 있습니다.");
        const form = new FormData();
        for (const file of files) form.append("files", file, file.name);
        form.append("paths", JSON.stringify(files.map((f) => f.webkitRelativePath || f.name)));
        form.append("replace", String(replace));
        result = await api.request("/api/skills/import", form);
      } else {
        const picked = await DocumentPicker.getDocumentAsync({
          type: "*/*",
          copyToCacheDirectory: true,
        });
        if (picked.canceled) return;
        const file = picked.assets[0];
        const response = await FileSystem.uploadAsync(`${API_URL}/api/skills/import`, file.uri, {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "files",
          mimeType: file.mimeType ?? "application/octet-stream",
          parameters: { replace: String(replace) },
          headers: { Authorization: `Bearer ${api.token}` },
        });
        result = JSON.parse(response.body);
        if (response.status < 200 || response.status >= 300)
          throw Error(
            (result as unknown as { error?: string }).error ?? "스킬 업로드에 실패했습니다.",
          );
      }
      setNotice(`추가됨: ${result.skills.map((s) => "/" + s.name).join(", ")}`);
      setReplace(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setDeleting(undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="스킬 관리"
      subtitle="스킬을 추가한 뒤 채팅에서 /스킬이름 요청 내용으로 사용하세요."
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button icon={Upload} primary busy={busy} onPress={() => void upload()}>
            스킬 파일·압축파일 업로드
          </Button>
          {Platform.OS === "web" && (
            <Button icon={FolderOpen} disabled={busy} onPress={() => void upload(true)}>
              스킬 폴더 업로드
            </Button>
          )}
        </View>
        <Text style={s.small}>
          Markdown · ZIP · .skill · TAR · TAR.GZ · TGZ / 최대 10MB. 폴더와 압축파일에는 SKILL.md를
          포함하세요. 여러 스킬이 든 묶음도 한 번에 추가할 수 있습니다.
        </Text>
        <CheckRow
          checked={replace}
          onPress={() => setReplace(!replace)}
          label="같은 이름의 스킬 교체"
        />
        {!!notice && <Text style={[s.text, { color: colors.success }]}>{notice}</Text>}
        <ErrorNotice error={error || loadError} />
        {!skills.length && <Text style={s.muted}>등록된 스킬이 없습니다.</Text>}
        {skills.map((skill) => (
          <Card key={skill.id} style={{ gap: 10 }}>
            <View style={s.between}>
              <Text style={s.heading}>/{skill.name}</Text>
              <Text style={s.small}>{skill.enabled ? "사용 가능" : "비활성화"}</Text>
            </View>
            <Text style={s.muted}>{skill.description}</Text>
            <Text style={s.small}>
              {skill.files.length}개 파일 · {(skill.size / 1024).toFixed(1)}KB
            </Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {onUse && (
                <Button small disabled={!skill.enabled || busy} onPress={() => onUse(skill.name)}>
                  채팅에 넣기
                </Button>
              )}
              <Button
                small
                disabled={busy}
                onPress={() =>
                  void change(async () =>
                    setDetail(await api.request(`/api/skills/${encodeURIComponent(skill.name)}`)),
                  )
                }
              >
                내용 보기
              </Button>
              <Button
                small
                disabled={busy}
                onPress={() =>
                  void change(() =>
                    api.request(
                      `/api/skills/${encodeURIComponent(skill.name)}`,
                      { enabled: !skill.enabled },
                      "PATCH",
                    ),
                  )
                }
              >
                {skill.enabled ? "비활성화" : "활성화"}
              </Button>
              <Button small danger disabled={busy} onPress={() => setDeleting(skill.name)}>
                삭제
              </Button>
            </View>
            {deleting === skill.name && (
              <View style={{ gap: 8 }}>
                <Text style={s.muted}>스킬과 첨부 파일을 삭제할까요?</Text>
                <View style={[s.row, { gap: 8 }]}>
                  <Button
                    small
                    danger
                    disabled={busy}
                    onPress={() =>
                      void change(() =>
                        api.request(
                          `/api/skills/${encodeURIComponent(skill.name)}`,
                          undefined,
                          "DELETE",
                        ),
                      )
                    }
                  >
                    스킬 삭제 확인
                  </Button>
                  <Button small onPress={() => setDeleting(undefined)}>
                    취소
                  </Button>
                </View>
              </View>
            )}
          </Card>
        ))}
      </View>
      {detail && (
        <Sheet
          title={`/${detail.skill.name}`}
          subtitle={detail.skill.description}
          onClose={() => setDetail(undefined)}
        >
          <Text selectable style={s.text}>
            {detail.instructions}
          </Text>
          <View style={{ marginTop: 20, gap: 5 }}>
            <Text style={s.heading}>포함된 파일</Text>
            {detail.skill.files.map((f) => (
              <Text key={f.path} style={s.small}>
                {f.path} · {f.size.toLocaleString()}바이트
              </Text>
            ))}
          </View>
        </Sheet>
      )}
    </Sheet>
  );
}

export function SkillsSettings() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card style={{ gap: 10 }}>
        <Text style={s.heading}>스킬</Text>
        <Text style={s.muted}>
          파일·폴더·압축파일로 작업 지침을 추가하고 채팅에서 /스킬이름으로 호출하세요.
        </Text>
        <Button icon={BookOpen} onPress={() => setOpen(true)}>
          스킬 관리
        </Button>
      </Card>
      {open && <SkillsManager onClose={() => setOpen(false)} />}
    </>
  );
}
