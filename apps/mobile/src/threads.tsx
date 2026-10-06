import {
  Archive,
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react-native";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { API_URL, type MuseApi } from "./api";
import { mergeThreadPages } from "./thread-state";
import { readStoredThreadId, writeStoredThreadId } from "./thread-storage";
import { Button, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Selection = { id: string; existing: boolean };
type ThreadMetadata = {
  id: string;
  name: string | null;
  agentId: string;
  organizationId: string;
  createdById: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  activeRunId: string | null;
  knowledgeSummary?: { category: string; issue: string; documentCount: number; hasNotes: boolean };
};

function useLocalThreads(api: MuseApi) {
  const [search, setSearch] = useState("");
  const loadVersion = useRef(0);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState("");
  const [fetchMoreError, setFetchMoreError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const version = ++loadVersion.current;
      if (append) {
        setIsFetchingMore(true);
        setFetchMoreError("");
      } else {
        setIsLoading(true);
        setError("");
      }
      try {
        const query = new URLSearchParams({
          agentId: "default",
          includeArchived: "true",
          limit: "20",
        });
        if (cursor) query.set("cursor", cursor);
        if (search.trim()) query.set("query", search.trim());
        const page = await api.request<{
          threads: ThreadMetadata[];
          nextCursor?: string | null;
        }>(`/api/copilotkit/threads?${query.toString()}`);
        if (version !== loadVersion.current) return;
        setThreads((current) => (append ? mergeThreadPages(current, page.threads) : page.threads));
        setNextCursor(page.nextCursor || null);
      } catch (cause) {
        if (version !== loadVersion.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (append) setFetchMoreError(message);
        else setError(message);
      } finally {
        if (version === loadVersion.current) {
          setIsLoading(false);
          setIsFetchingMore(false);
        }
      }
    },
    [api, search],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 200 : 0);
    return () => {
      clearTimeout(timer);
      loadVersion.current++;
    };
  }, [load, search]);

  const mutate = useCallback(async <T,>(operation: () => Promise<T>) => {
    setIsMutating(true);
    try {
      return await operation();
    } finally {
      setIsMutating(false);
    }
  }, []);

  const createThread = useCallback(
    (id: string) =>
      mutate(async () => {
        const created = await api.request<ThreadMetadata>("/api/copilotkit/threads", {
          id,
          agentId: "default",
        });
        setThreads((current) => [created, ...current.filter((thread) => thread.id !== created.id)]);
        return created;
      }),
    [api, mutate],
  );

  const replaceThread = useCallback((updated: ThreadMetadata) => {
    setThreads((current) => current.map((thread) => (thread.id === updated.id ? updated : thread)));
  }, []);

  const renameThread = useCallback(
    (threadId: string, name: string) =>
      mutate(async () => {
        const updated = await api.request<ThreadMetadata>(
          `/api/copilotkit/threads/${encodeURIComponent(threadId)}`,
          { name },
          "PATCH",
        );
        replaceThread(updated);
      }),
    [api, mutate, replaceThread],
  );

  const archiveThread = useCallback(
    (threadId: string) =>
      mutate(async () => {
        const updated = await api.request<ThreadMetadata>(
          `/api/copilotkit/threads/${encodeURIComponent(threadId)}/archive`,
          undefined,
          "POST",
        );
        replaceThread(updated);
      }),
    [api, mutate, replaceThread],
  );

  const restoreThread = useCallback(
    (threadId: string) =>
      mutate(async () => {
        const updated = await api.request<ThreadMetadata>(
          `/api/copilotkit/threads/${encodeURIComponent(threadId)}/restore`,
          undefined,
          "POST",
        );
        replaceThread(updated);
      }),
    [api, mutate, replaceThread],
  );

  const deleteThread = useCallback(
    (threadId: string) =>
      mutate(async () => {
        await api.request(
          `/api/copilotkit/threads/${encodeURIComponent(threadId)}`,
          undefined,
          "DELETE",
        );
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
      }),
    [api, mutate],
  );
  return {
    search,
    setSearch,
    threads,
    isLoading,
    isFetchingMore,
    isMutating,
    listError: error,
    fetchMoreError,
    hasMore: !!nextCursor,
    fetchMore: () => {
      if (nextCursor && !isFetchingMore) void load(nextCursor, true);
    },
    refetch: () => void load(),
    createThread,
    renameThread,
    archiveThread,
    restoreThread,
    deleteThread,
  };
}

type ThreadContextValue = ReturnType<typeof useLocalThreads> & {
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: () => Promise<void>;
  claimPrompt: (id: number) => boolean;
};

const ThreadContext = createContext<ThreadContextValue | null>(null);

export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { navigate, api } = useWorkspace();
  const localThreads = useLocalThreads(api);
  const handledPrompt = useRef(0);
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const select = useCallback(
    (next: Selection) => {
      setSelection(next);
      setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
      void writeStoredThreadId(API_URL, next.id).catch(() => undefined);
      navigate("chat");
    },
    [navigate],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([
      api.request<{ threadId: string; existing: boolean }>("/api/main-thread"),
      readStoredThreadId(API_URL),
    ])
      .then(([main, storedId]) => {
        if (!active) return;
        const next = { id: storedId || main.threadId, existing: true };
        setMainId(main.threadId);
        setSelection(next);
        setVisited([next]);
        if (!storedId) void writeStoredThreadId(API_URL, main.threadId).catch(() => undefined);
        setLoading(false);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);

  return (
    <ThreadContext.Provider
      value={{
        ...localThreads,
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        mainId,
        visited,
        loading,
        error,
        retry: () => setAttempt((count) => count + 1),
        selection,
        select,
        start: async () => {
          const thread = await localThreads.createThread(newThreadId());
          select({ id: thread.id, existing: true });
        },
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}

export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("대화 기록을 사용할 수 없습니다");
  return context;
}

export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const {
    selection,
    search,
    setSearch,
    mainId,
    loading,
    error: mainError,
    retry,
    select,
    start,
    threads,
    isLoading,
    isFetchingMore,
    isMutating,
    listError: threadsError,
    fetchMoreError,
    hasMore,
    fetchMore,
    refetch,
    renameThread,
    archiveThread,
    restoreThread,
    deleteThread,
  } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState<string>();

  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function go(section: "calendar" | "files" | "apps") {
    onClose();
    navigate(section);
  }

  return (
    <Sheet
      title="OpenMuse"
      subtitle={workspace.mode === "sample" ? "내 워크스페이스" : workspace.profile.name}
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        {loading ? (
          <>
            <ErrorNotice error={mainError} />
            {mainError ? (
              <Button onPress={retry}>기본 대화 다시 연결</Button>
            ) : (
              <ActivityIndicator color={colors.blueDark} />
            )}
          </>
        ) : (
          <>
            <LinkRow
              icon={MessageCircle}
              title="기본 대화"
              detail="계속 이어가는 대화"
              onPress={() => {
                select({ id: mainId, existing: true });
                onClose();
              }}
            />
            <Button
              primary
              icon={Plus}
              busy={isMutating}
              onPress={() =>
                void mutate(async () => {
                  await start();
                  onClose();
                })
              }
            >
              새 별도 대화
            </Button>
            <View style={[s.between, { marginTop: 12 }]}>
              <Text style={s.heading}>별도 대화</Text>
              <Button small onPress={() => setArchived(!archived)}>
                {archived ? "활성 대화 보기" : "보관함"}
              </Button>
            </View>
            {isLoading && <ActivityIndicator color={colors.blueDark} />}
            <Field
              label="대화 검색"
              placeholder="카테고리·이슈·대화 이름"
              value={search}
              maxLength={200}
              onChangeText={setSearch}
            />
            <ErrorNotice error={error || threadsError} />
            {!!threadsError && (
              <Button small onPress={refetch}>
                대화 다시 연결
              </Button>
            )}
            {threads
              .filter((thread) => thread.id !== mainId && thread.archived === archived)
              .map((thread) => (
                <View
                  key={thread.id}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                    gap: 10,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`대화 열기: ${thread.name || "제목 없는 대화"}`}
                    accessibilityState={{ selected: selection.id === thread.id }}
                    onPress={() =>
                      void mutate(async () => {
                        if (thread.archived) await restoreThread(thread.id);
                        select({ id: thread.id, existing: true });
                        onClose();
                      })
                    }
                    style={[s.row, { gap: 10 }]}
                  >
                    <MessageCircle size={19} color={colors.text} />
                    <Text style={[s.text, { flex: 1 }]}>{thread.name || "제목 없는 대화"}</Text>
                  </Pressable>
                  {editing === thread.id && (
                    <Field label="대화 이름" value={name} onChangeText={setName} />
                  )}
                  {(thread.knowledgeSummary?.category || thread.knowledgeSummary?.issue) && (
                    <Text style={s.small}>
                      {[thread.knowledgeSummary.category, thread.knowledgeSummary.issue]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  )}
                  <View style={[s.row, { gap: 8 }]}>
                    <Button
                      small
                      disabled={isMutating || (editing === thread.id && !name.trim())}
                      onPress={() => {
                        if (editing === thread.id)
                          void mutate(() => renameThread(thread.id, name.trim()));
                        else {
                          setEditing(thread.id);
                          setName(thread.name || "");
                        }
                      }}
                    >
                      {editing === thread.id ? "이름 저장" : "이름 변경"}
                    </Button>
                    <Button
                      small
                      icon={Archive}
                      disabled={isMutating}
                      onPress={() =>
                        void mutate(async () => {
                          if (thread.archived) await restoreThread(thread.id);
                          else {
                            await archiveThread(thread.id);
                            if (selection.id === thread.id) select({ id: mainId, existing: true });
                          }
                        })
                      }
                    >
                      {thread.archived ? "복원" : "보관"}
                    </Button>
                    {thread.archived && (
                      <Button
                        small
                        danger
                        icon={Trash2}
                        disabled={isMutating}
                        onPress={() => {
                          if (deleting !== thread.id) {
                            setDeleting(thread.id);
                            return;
                          }
                          void mutate(async () => {
                            await deleteThread(thread.id);
                            if (selection.id === thread.id) select({ id: mainId, existing: true });
                            setDeleting(undefined);
                          });
                        }}
                      >
                        {deleting === thread.id ? "복구 불가 · 삭제 확인" : "완전 삭제"}
                      </Button>
                    )}
                  </View>
                </View>
              ))}
            {!isLoading &&
              !threadsError &&
              !threads.some((thread) => thread.id !== mainId && thread.archived === archived) && (
                <Text style={s.muted}>
                  {archived
                    ? "보관된 대화가 없습니다."
                    : "별도의 주제로 대화하세요. 기본 대화는 항상 사용할 수 있습니다."}
                </Text>
              )}
            <ErrorNotice error={fetchMoreError} />
            {hasMore && (
              <Button small busy={isFetchingMore} onPress={fetchMore}>
                대화 더 불러오기
              </Button>
            )}
            <Text style={s.small}>
              주요 메모와 참고 문서는 채팅별로 유지됩니다. 전체 공유를 요청한 기억만 워크스페이스에
              저장됩니다.
            </Text>
          </>
        )}
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="작업 맡기기"
          detail="계획, 문서 또는 지출 요약"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="에이전트 컴퓨터"
          detail="브라우저, 세션과 문서"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="일정" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="파일" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="앱과 설정" onPress={() => go("apps")} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          워크스페이스 새로고침
        </Button>
      </View>
    </Sheet>
  );
}
