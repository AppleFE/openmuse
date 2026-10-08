import { ArrowRight, Bell, ChevronDown, ChevronUp, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { uiLabel } from "./locale";
import { Button, Card, colors, ErrorNotice, resultSummary, s } from "./ui";
import { useWorkspace } from "./workspace";

export function BackgroundUpdates() {
  const { data, mutate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string>();
  const updates = data?.notifications.filter((item) => !item.read && item.taskId) || [];
  const update = updates[0];
  if (!update || data?.identity.showChatUpdates === false) return null;
  const expanded = expandedId === update.id;
  async function dismiss(all = false) {
    if (!update) return;
    setBusy(true);
    try {
      await mutate("/notifications/read", {
        ids: all ? updates.map((item) => item.id) : [update.id],
      });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ backgroundColor: colors.sky, padding: 16, gap: 10 }}>
      <View style={[s.between, { gap: 12 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`백그라운드 업데이트 ${updates.length}개 ${expanded ? "접기" : "펼치기"}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpandedId(expanded ? undefined : update.id)}
          style={[s.row, { gap: 7, flex: 1 }]}
        >
          <Bell size={14} color={colors.blueDark} />
          <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>
            새 업데이트 {updates.length}개 · {uiLabel(update.title)}
          </Text>
          {expanded ? (
            <ChevronUp size={16} color={colors.muted} />
          ) : (
            <ChevronDown size={16} color={colors.muted} />
          )}
        </Pressable>
        <Button small busy={busy} onPress={() => void dismiss(true)}>
          모두 확인
        </Button>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="백그라운드 업데이트 닫기"
          disabled={busy}
          onPress={() => void dismiss()}
          hitSlop={10}
          style={{ padding: 6 }}
        >
          <X size={16} color={colors.muted} />
        </Pressable>
      </View>
      {expanded && (
        <>
          <Text style={s.heading}>{uiLabel(update.title)}</Text>
          <Text style={s.text}>{resultSummary(update.body)}</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              icon={ArrowRight}
              onPress={() => update.taskId && open({ type: "task", taskId: update.taskId })}
            >
              작업 보기
            </Button>
            {updates.length > 1 && (
              <Button small onPress={() => open({ type: "notifications" })}>
                {updates.length - 1} 개 추가 업데이트
              </Button>
            )}
          </View>
        </>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
