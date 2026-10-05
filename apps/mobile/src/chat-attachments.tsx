import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Download, FileText, FolderOpen, ImagePlus, Paperclip, X } from "lucide-react-native";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  type ChatAttachment,
  attachmentLimits as limits,
} from "../../../packages/domain/src/attachments";
import { API_URL } from "./api";
import {
  checkUploadFiles,
  chooseWebAttachments,
  droppedAttachments,
  ignoredAttachmentPath,
  type WebAttachment,
} from "./attachment-input";
import { Button, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sizeLabel = (size: number) =>
  size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))}KB`
    : `${(size / 1024 / 1024).toFixed(1)}MB`;
export function useChatAttachments(
  threadId: string,
  active: boolean,
  root: RefObject<View | null>,
) {
  const { api } = useWorkspace();
  const [files, setFiles] = useState<ChatAttachment[]>([]),
    [selected, setSelected] = useState<ChatAttachment[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const locked = useRef(false),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refresh = useCallback(async () => {
    const result = await api.request<{ files: ChatAttachment[] }>(
      `/api/attachments?threadId=${encodeURIComponent(threadId)}`,
    );
    setFiles(result.files);
    setSelected((old) => old.map((file) => result.files.find((f) => f.id === file.id) ?? file));
    return result.files;
  }, [api, threadId]);
  useEffect(() => {
    if (!active) return;
    void refresh().catch((e) => setError(errorText(e)));
    const timer = setInterval(
      () => {
        void refresh().catch(() => {});
      },
      10 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [active, refresh]);
  const accept = useCallback((uploaded: ChatAttachment[]) => {
    setFiles((old) => [...uploaded, ...old.filter((f) => !uploaded.some((u) => u.id === f.id))]);
    setSelected((old) => [...old, ...uploaded]);
  }, []);
  const upload = useCallback(
    async (input: WebAttachment[]) => {
      if (!input.length) return;
      if (locked.current) {
        setError("현재 업로드가 끝난 뒤 다시 첨부해 주세요.");
        return;
      }
      locked.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const picked = input.filter((f) => !ignoredAttachmentPath(f.path));
        if (input.length !== picked.length)
          setNotice(".git, node_modules, __pycache__, .venv 폴더는 제외했습니다.");
        if (!picked.length) return;
        checkUploadFiles(
          picked.map((f) => f.file),
          selectedRef.current,
        );
        const form = new FormData();
        for (const { file } of picked) form.append("files", file, file.name);
        form.append("paths", JSON.stringify(picked.map((f) => f.path)));
        form.append("threadId", threadId);
        accept((await api.request<{ files: ChatAttachment[] }>("/api/attachments", form)).files);
      } catch (e) {
        setError(errorText(e));
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [api, threadId, accept],
  );
  useEffect(() => {
    if (Platform.OS !== "web" || !active) return;
    const element = root.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return; // Preserve ordinary text paste, without clipboard permission prompts.
      event.preventDefault();
      void upload(
        files.map((file) => ({ file, path: file.name || `clipboard-${Date.now()}.png` })),
      );
    };
    const drag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      void droppedAttachments(event.dataTransfer)
        .then(upload)
        .catch((e) => setError(errorText(e)));
    };
    element.addEventListener("paste", paste);
    element.addEventListener("dragover", drag);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("paste", paste);
      element.removeEventListener("dragover", drag);
      element.removeEventListener("drop", drop);
    };
  }, [active, root, upload]);
  async function uploadNative(uri: string, name: string, mimeType?: string) {
    const result = await FileSystem.uploadAsync(`${API_URL}/api/attachments`, uri, {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "files",
      mimeType: mimeType ?? "application/octet-stream",
      parameters: { threadId, paths: JSON.stringify([name]) },
      headers: { Authorization: `Bearer ${api.token}` },
    });
    const payload = JSON.parse(result.body);
    if (result.status < 200 || result.status >= 300)
      throw Error(payload.error ?? "파일 업로드에 실패했습니다.");
    accept(payload.files);
    return payload.files as ChatAttachment[];
  }
  async function choose(kind: "image" | "file" | "folder") {
    if (locked.current) return;
    setError("");
    try {
      if (Platform.OS === "web") {
        await upload(await chooseWebAttachments(kind));
        return;
      }
      const picked = await DocumentPicker.getDocumentAsync({
        type: kind === "image" ? "image/*" : "*/*",
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      checkUploadFiles(
        picked.assets.map((f) => ({ size: f.size ?? 0 })),
        selectedRef.current,
      );
      locked.current = true;
      setBusy(true);
      for (const file of picked.assets) await uploadNative(file.uri, file.name, file.mimeType);
    } catch (e) {
      setError(errorText(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function pasteNative() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    let uri: string | undefined;
    try {
      const image = await Clipboard.getImageAsync({ format: "png" });
      if (!image) throw Error("클립보드에 이미지가 없습니다.");
      const data = image.data.replace(/^data:[^,]+,/, "");
      checkUploadFiles([{ size: Math.ceil((data.length * 3) / 4) }], selectedRef.current);
      const name = `clipboard-${Date.now()}.png`;
      uri = `${FileSystem.cacheDirectory}${name}`;
      await FileSystem.writeAsStringAsync(uri, data, { encoding: FileSystem.EncodingType.Base64 });
      await uploadNative(uri, name, "image/png");
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      locked.current = false;
      setBusy(false);
    }
  }
  function ready() {
    const images = selected.filter((f) => f.kind === "image");
    if (busy) {
      setError("업로드가 끝난 뒤 전송하세요.");
      return false;
    }
    if (
      images.length > limits.images ||
      images.reduce((n, f) => n + f.size, 0) > limits.imageBytes
    ) {
      setError("한 메시지의 이미지는 6개, 합계 20MB까지 지원합니다.");
      return false;
    }
    return true;
  }
  return {
    files,
    selected,
    busy,
    error,
    notice,
    ready,
    choose,
    pasteNative,
    refresh,
    clear: () => setSelected([]),
    remove: (id: string) => {
      setSelected((old) => old.filter((f) => f.id !== id));
      void api
        .request(`/api/attachments/${id}`, undefined, "DELETE")
        .then(() => setFiles((old) => old.filter((f) => f.id !== id)))
        .catch((e) => setError(errorText(e)));
    },
  };
}
export function AttachmentUploadButtons({
  state,
}: {
  state: ReturnType<typeof useChatAttachments>;
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
        <Button
          small
          icon={ImagePlus}
          disabled={state.busy}
          onPress={() => void state.choose("image")}
        >
          이미지
        </Button>
        <Button
          small
          icon={Paperclip}
          disabled={state.busy}
          onPress={() => void state.choose("file")}
        >
          파일
        </Button>
        {Platform.OS === "web" ? (
          <Button
            small
            icon={FolderOpen}
            disabled={state.busy}
            onPress={() => void state.choose("folder")}
          >
            폴더
          </Button>
        ) : (
          <Button small disabled={state.busy} onPress={() => void state.pasteNative()}>
            클립보드 이미지
          </Button>
        )}
      </View>
      <Text style={s.small}>
        {Platform.OS === "web" ? "파일·폴더를 끌어 놓거나 입력창에 이미지를 붙여넣으세요. " : ""}
        파일당 20MB · 합계 100MB · 200개 · 이미지 6개
      </Text>
    </View>
  );
}
export function AttachmentChips({
  files,
  onRemove,
}: {
  files: ChatAttachment[];
  onRemove?: (id: string) => void;
}) {
  const [preview, setPreview] = useState<ChatAttachment>();
  const { api } = useWorkspace();
  const [error, setError] = useState("");
  async function download(file: ChatAttachment) {
    try {
      const result = await api.request<{ files: ChatAttachment[] }>(
        `/api/attachments?threadId=${encodeURIComponent(file.threadId)}`,
      );
      const url = result.files.find((f) => f.id === file.id)?.url;
      if (!url) throw Error("파일을 찾을 수 없습니다.");
      await Linking.openURL(`${url}&download=1`);
    } catch (e) {
      setError(errorText(e));
    }
  }
  if (!files.length) return null;
  return (
    <View style={{ gap: 6, maxWidth: "100%" }}>
      <ScrollView style={{ maxHeight: onRemove ? 160 : 280 }} contentContainerStyle={{ gap: 6 }}>
        {files.map((file) => (
          <View
            key={file.id}
            style={[
              s.row,
              {
                gap: 8,
                padding: 9,
                borderRadius: 14,
                backgroundColor: colors.surfaceMuted,
                maxWidth: "100%",
              },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`첨부 파일 열기: ${file.path}`}
              onPress={() => (file.kind === "image" ? setPreview(file) : void download(file))}
              style={[s.row, { flex: 1, gap: 8, minWidth: 0 }]}
            >
              {file.kind === "image" && file.url ? (
                <Image
                  source={{ uri: file.url }}
                  style={{ width: 52, height: 52, borderRadius: 8 }}
                  resizeMode="cover"
                />
              ) : (
                <FileText size={20} color={colors.blueDark} />
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} style={s.small}>
                  {file.path}
                </Text>
                <Text style={s.small}>
                  {sizeLabel(file.size)}
                  {file.kind === "binary" ? " · 저장/다운로드" : ""}
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                onRemove ? `첨부 파일 제거: ${file.path}` : `첨부 파일 다운로드: ${file.path}`
              }
              onPress={() => (onRemove ? onRemove(file.id) : void download(file))}
              style={{ padding: 7 }}
            >
              {onRemove ? (
                <X size={16} color={colors.muted} />
              ) : (
                <Download size={16} color={colors.muted} />
              )}
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <ErrorNotice error={error} />
      {preview && (
        <Sheet title={preview.name} subtitle={preview.path} onClose={() => setPreview(undefined)}>
          <Image
            source={{ uri: preview.url }}
            style={{ width: "100%", height: 400 }}
            resizeMode="contain"
          />
          <Button icon={Download} onPress={() => void download(preview)}>
            원본 다운로드
          </Button>
        </Sheet>
      )}
    </View>
  );
}
