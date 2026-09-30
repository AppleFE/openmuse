import {
  Archive,
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
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
};

function useLocalThreads(api: MuseApi) {
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState("");
  const [fetchMoreError, setFetchMoreError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string, append = false) => {
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
        const page = await api.request<{
          threads: ThreadMetadata[];
          nextCursor?: string | null;
        }>(`/api/copilotkit/threads?${query.toString()}`);
        setThreads((current) => (append ? mergeThreadPages(current, page.threads) : page.threads));
        setNextCursor(page.nextCursor || null);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (append) setFetchMoreError(message);
        else setError(message);
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

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

  return {
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
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}

export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const {
    selection,
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
  } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);

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
      subtitle={workspace.mode === "sample" ? "Your workspace" : workspace.profile.name}
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        {loading ? (
          <>
            <ErrorNotice error={mainError} />
            {mainError ? (
              <Button onPress={retry}>Retry main chat</Button>
            ) : (
              <ActivityIndicator color={colors.blueDark} />
            )}
          </>
        ) : (
          <>
            <LinkRow
              icon={MessageCircle}
              title="Main chat"
              detail="Your ongoing conversation"
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
              New side chat
            </Button>
            <View style={[s.between, { marginTop: 12 }]}>
              <Text style={s.heading}>Side chats</Text>
              <Button small onPress={() => setArchived(!archived)}>
                {archived ? "Show active" : "Archived"}
              </Button>
            </View>
            {isLoading && <ActivityIndicator color={colors.blueDark} />}
            <ErrorNotice error={error || threadsError} />
            {!!threadsError && (
              <Button small onPress={refetch}>
                Retry conversations
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
                    accessibilityLabel={`Open conversation: ${thread.name || "Untitled conversation"}`}
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
                    <Text style={[s.text, { flex: 1 }]}>
                      {thread.name || "Untitled conversation"}
                    </Text>
                  </Pressable>
                  {editing === thread.id && (
                    <Field label="Conversation name" value={name} onChangeText={setName} />
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
                      {editing === thread.id ? "Save name" : "Rename"}
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
                      {thread.archived ? "Restore" : "Archive"}
                    </Button>
                  </View>
                </View>
              ))}
            {!isLoading &&
              !threadsError &&
              !threads.some((thread) => thread.id !== mainId && thread.archived === archived) && (
                <Text style={s.muted}>
                  {archived
                    ? "No archived conversations."
                    : "Keep a separate topic here. Your main chat is always available."}
                </Text>
              )}
            <ErrorNotice error={fetchMoreError} />
            {hasMore && (
              <Button small busy={isFetchingMore} onPress={fetchMore}>
                Load more conversations
              </Button>
            )}
            <Text style={s.small}>
              Side chats keep their own conversation context. Your agent’s saved memory is shared.
            </Text>
          </>
        )}
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="Delegate task"
          detail="A plan, document, or spending summary"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="Agent computer"
          detail="Browser, sessions and documents"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="Calendar" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="Files" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="Apps & settings" onPress={() => go("apps")} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          Refresh workspace
        </Button>
      </View>
    </Sheet>
  );
}
