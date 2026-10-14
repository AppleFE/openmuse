import { ShieldCheck, TerminalSquare } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import type {
  JevFailMode,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "../../../packages/domain/src/agent";
import { UI_LOCALE } from "./locale";
import { parseRuntimeInteger, runtimeLimits } from "./runtime-settings-core";
import { Button, Card, CheckRow, colors, ErrorNotice, Field, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function Status({ label, ready }: { label: string; ready: boolean }) {
  return (
    <Text style={[s.small, { color: ready ? colors.success : colors.muted, fontWeight: "700" }]}>
      {label}
    </Text>
  );
}

export function RuntimeSettings() {
  const { api, notify } = useWorkspace();
  const [settings, setSettings] = useState<RuntimeSettingsView>();
  const [jevEnabled, setJevEnabled] = useState(false);
  const [jevKey, setJevKey] = useState("");
  const [clearJevKey, setClearJevKey] = useState(false);
  const [jevModel, setJevModel] = useState("");
  const [jevFailMode, setJevFailMode] = useState<JevFailMode>("closed");
  const [jevTimeoutMs, setJevTimeoutMs] = useState("");
  const [piEnabled, setPiEnabled] = useState(false);
  const [piMaxIterations, setPiMaxIterations] = useState("");
  const [piTimeoutMs, setPiTimeoutMs] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const apply = useCallback((next: RuntimeSettingsView) => {
    setSettings(next);
    setJevEnabled(next.jev.enabled);
    setJevKey("");
    setClearJevKey(false);
    setJevModel(next.jev.model);
    setJevFailMode(next.jev.failMode);
    setJevTimeoutMs(String(next.jev.timeoutMs));
    setPiEnabled(next.pi.enabled);
    setPiMaxIterations(String(next.pi.maxIterations));
    setPiTimeoutMs(String(next.pi.timeoutMs));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.request<RuntimeSettingsView>("/api/agent/runtime-settings");
      apply(next);
      setError("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [api, apply]);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const model = jevModel.trim();
      if (!/^jev[-a-zA-Z0-9._]*$/.test(model) || model.length > 120)
        throw new Error(
          "Jev 모델은 jev로 시작하며 영문, 숫자, 점, 하이픈과 밑줄만 사용할 수 있습니다.",
        );
      const key = jevKey.trim();
      if (key && key.length < 8) throw new Error("Jev API 키는 8자 이상이어야 합니다.");
      const willHaveKey = Boolean(key) || Boolean(settings?.jev.configured && !clearJevKey);
      if (jevEnabled && !willHaveKey)
        throw new Error("Jev 가드레일을 켜려면 먼저 API 키를 입력하세요.");
      const patch: RuntimeSettingsPatch = {
        jev: {
          enabled: jevEnabled,
          model,
          failMode: jevFailMode,
          timeoutMs: parseRuntimeInteger(
            jevTimeoutMs,
            "Jev 응답 제한 시간",
            runtimeLimits.jevTimeoutMs,
          ),
          ...(clearJevKey ? { apiKey: null } : key ? { apiKey: key } : {}),
        },
        pi: {
          enabled: piEnabled,
          maxIterations: parseRuntimeInteger(
            piMaxIterations,
            "Pi 반복 횟수",
            runtimeLimits.piMaxIterations,
          ),
          timeoutMs: parseRuntimeInteger(piTimeoutMs, "Pi 제한 시간", runtimeLimits.piTimeoutMs),
        },
      };
      const next = await api.request<RuntimeSettingsView>(
        "/api/agent/runtime-settings",
        patch,
        "PATCH",
      );
      apply(next);
      notify("코딩 런타임 설정을 저장했습니다.");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !settings)
    return (
      <Card>
        <Text style={s.muted}>코딩 런타임 설정을 불러오는 중…</Text>
      </Card>
    );

  if (!settings)
    return (
      <Card style={{ gap: 10 }}>
        <SectionHeading title="코딩 런타임" />
        <ErrorNotice error={error || "런타임 설정을 사용할 수 없습니다."} />
        <Button onPress={() => void refresh()}>런타임 설정 다시 시도</Button>
      </Card>
    );

  const keyConfigured = Boolean(jevKey.trim()) || (settings.jev.configured && !clearJevKey);
  return (
    <Card style={{ gap: 18 }}>
      <SectionHeading title="코딩 런타임" />
      <Text style={s.muted}>
        모델 팀이 사용하는 서버 런타임의 제한을 설정합니다. 이후 역할 실행부터 적용되며 인증 정보는
        서버에만 저장됩니다.
      </Text>

      <Card style={{ gap: 12, borderWidth: 1, backgroundColor: colors.surfaceMuted }}>
        <View style={[s.between, { gap: 12 }]}>
          <View style={[s.row, { gap: 10, flex: 1 }]}>
            <ShieldCheck size={20} color={colors.blueDark} />
            <Text style={s.heading}>Jev 컨텍스트와 가드레일</Text>
          </View>
          <Status
            label={jevEnabled ? (keyConfigured ? "준비됨" : "API 키 필요") : "꺼짐"}
            ready={jevEnabled && keyConfigured}
          />
        </View>
        <Text style={s.small}>
          Jev가 필요한 최소 컨텍스트를 선택하고 역할·도구 실행을 검증하며 제한된 Pi 실행의
          완료·계속·중지를 판단합니다.
        </Text>
        <CheckRow
          label="모델 팀에 Jev 사용"
          checked={jevEnabled}
          onPress={() => setJevEnabled(!jevEnabled)}
        />
        <Field
          label={
            settings.jev.configured && !clearJevKey ? "Jev API 키(서버에 설정됨)" : "Jev API 키"
          }
          value={jevKey}
          onChangeText={(value) => {
            setJevKey(value);
            if (value) setClearJevKey(false);
          }}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={
            settings.jev.configured ? "저장된 키를 유지하려면 비워 두세요" : "서버 인증 정보 입력"
          }
        />
        {settings.jev.configured && (
          <Button small danger={clearJevKey} onPress={() => setClearJevKey(!clearJevKey)}>
            {clearJevKey ? "저장된 API 키 설정 유지" : "저장 시 API 키 설정 삭제"}
          </Button>
        )}
        <Field
          label="Jev 모델"
          value={jevModel}
          onChangeText={setJevModel}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="jev-latest"
        />
        <View style={{ gap: 8 }}>
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>
            오류 시 처리 방식
          </Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {(["closed", "local-budget"] as JevFailMode[]).map((mode) => (
              <Button
                key={mode}
                small
                primary={jevFailMode === mode}
                onPress={() => setJevFailMode(mode)}
              >
                {mode === "closed" ? "사용할 수 없으면 중지" : "제한된 로컬 실행 허용"}
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            {jevFailMode === "closed"
              ? "Jev가 응답하지 않으면 설정된 가드레일 없이 실행하지 않고 역할을 중지합니다."
              : "Jev가 응답하지 않으면 기록을 남기고 로컬에서 제한된 실행 한 번을 허용한 뒤 중지합니다."}
          </Text>
        </View>
        <Field
          label="Jev 응답 제한 시간(밀리초, 1000~30000)"
          value={jevTimeoutMs}
          onChangeText={setJevTimeoutMs}
          keyboardType="number-pad"
        />
      </Card>

      <Card style={{ gap: 12, borderWidth: 1, backgroundColor: colors.surfaceMuted }}>
        <View style={[s.between, { gap: 12 }]}>
          <View style={[s.row, { gap: 10, flex: 1 }]}>
            <TerminalSquare size={20} color={colors.blueDark} />
            <Text style={s.heading}>내장 Pi 런타임</Text>
          </View>
          <Status label={piEnabled ? "켜짐" : "꺼짐"} ready={piEnabled} />
        </View>
        <Text style={s.small}>
          Pi는 서버에서 허용한 역할 모델로 제한된 코딩 작업을 수행합니다. 격리된 Docker 컴퓨터와
          읽기 전용 커넥터를 사용하며 호스트의 셸·파일에는 접근하지 않습니다.
        </Text>
        <CheckRow
          label="모델 팀에 Pi 사용"
          checked={piEnabled}
          onPress={() => setPiEnabled(!piEnabled)}
        />
        <Field
          label="최대 반복 횟수(1~8)"
          value={piMaxIterations}
          onChangeText={setPiMaxIterations}
          keyboardType="number-pad"
        />
        <Field
          label="응답 없음 제한(밀리초, 5000~900000 · 진행 중이면 최대 60분)"
          value={piTimeoutMs}
          onChangeText={setPiTimeoutMs}
          keyboardType="number-pad"
        />
      </Card>

      <ErrorNotice error={error} />
      <Button primary busy={busy} onPress={() => void save()}>
        런타임 설정 저장
      </Button>
      <Text style={s.small}>
        마지막 저장: {new Date(settings.updatedAt).toLocaleString(UI_LOCALE)}
      </Text>
    </Card>
  );
}
