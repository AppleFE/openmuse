import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import { Button, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

type Tabs = { tabs: { tab_id: string; title: string; url: string; active: boolean }[] };
export function BrowserTabs({ browser }: { browser: BrowserSession }) {
  const { api, refresh } = useWorkspace();
  const [state, setState] = useState<Tabs>({ tabs: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .request<Tabs>(`/api/browsers/${browser.id}/tabs`)
        .then((value) => {
          if (live) setState(value);
        })
        .catch(() => {});
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, browser.id]);
  async function change(action: string, tab_id?: string) {
    setBusy(true);
    setError("");
    try {
      setState(await api.request<Tabs>(`/api/browsers/${browser.id}/tabs`, { action, tab_id }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!state.tabs.length) return null;
  const disabled = busy || browser.control !== "user";
  return (
    <View style={{ gap: 8, marginBottom: 12 }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        {state.tabs.map((tab) => (
          <Button
            key={tab.tab_id}
            small
            primary={tab.active}
            disabled={disabled}
            onPress={() => void change("switch_tab", tab.tab_id)}
          >
            {(tab.title || "새 탭").slice(0, 35)}
          </Button>
        ))}
        <Button
          small
          disabled={disabled || state.tabs.length >= 10}
          onPress={() => void change("new_tab")}
        >
          + 새 탭
        </Button>
        {state.tabs.length > 1 && (
          <Button
            small
            disabled={disabled}
            onPress={() => void change("close_tab", state.tabs.find((t) => t.active)?.tab_id)}
          >
            현재 탭 닫기
          </Button>
        )}
      </View>
      {browser.control !== "user" && (
        <Text style={s.small}>직접 탭을 변경하려면 화면 제어를 가져오세요.</Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
