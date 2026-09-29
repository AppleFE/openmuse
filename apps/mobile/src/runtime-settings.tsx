import { ShieldCheck, TerminalSquare } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import type {
  JevFailMode,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "../../../packages/domain/src/agent";
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
          "Jev model must start with jev and use only letters, numbers, dot, dash, or underscore.",
        );
      const key = jevKey.trim();
      if (key && key.length < 8) throw new Error("Jev API key must contain at least 8 characters.");
      const willHaveKey = Boolean(key) || Boolean(settings?.jev.configured && !clearJevKey);
      if (jevEnabled && !willHaveKey)
        throw new Error("Add a Jev API key before enabling Jev guardrails.");
      const patch: RuntimeSettingsPatch = {
        jev: {
          enabled: jevEnabled,
          model,
          failMode: jevFailMode,
          timeoutMs: parseRuntimeInteger(jevTimeoutMs, "Jev timeout", runtimeLimits.jevTimeoutMs),
          ...(clearJevKey ? { apiKey: null } : key ? { apiKey: key } : {}),
        },
        pi: {
          enabled: piEnabled,
          maxIterations: parseRuntimeInteger(
            piMaxIterations,
            "Pi iterations",
            runtimeLimits.piMaxIterations,
          ),
          timeoutMs: parseRuntimeInteger(piTimeoutMs, "Pi timeout", runtimeLimits.piTimeoutMs),
        },
      };
      const next = await api.request<RuntimeSettingsView>(
        "/api/agent/runtime-settings",
        patch,
        "PATCH",
      );
      apply(next);
      notify("Coding runtime settings saved.");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !settings)
    return (
      <Card>
        <Text style={s.muted}>Loading coding runtime settings…</Text>
      </Card>
    );

  if (!settings)
    return (
      <Card style={{ gap: 10 }}>
        <SectionHeading title="Coding runtime" />
        <ErrorNotice error={error || "Runtime settings are unavailable."} />
        <Button onPress={() => void refresh()}>Retry runtime settings</Button>
      </Card>
    );

  const keyConfigured = Boolean(jevKey.trim()) || (settings.jev.configured && !clearJevKey);
  return (
    <Card style={{ gap: 18 }}>
      <SectionHeading title="Coding runtime" />
      <Text style={s.muted}>
        Configure the bounded server runtimes used by model-team roles. Changes apply to future role
        calls; credentials stay write-only on your server.
      </Text>

      <Card style={{ gap: 12, borderWidth: 1, backgroundColor: colors.surfaceMuted }}>
        <View style={[s.between, { gap: 12 }]}>
          <View style={[s.row, { gap: 10, flex: 1 }]}>
            <ShieldCheck size={20} color={colors.blueDark} />
            <Text style={s.heading}>Jev context and guardrails</Text>
          </View>
          <Status
            label={jevEnabled ? (keyConfigured ? "Ready" : "API key required") : "Off"}
            ready={jevEnabled && keyConfigured}
          />
        </View>
        <Text style={s.small}>
          Jev selects the smallest sufficient context, guards role and tool execution, and decides
          whether each bounded pi turn should complete, continue, or stop.
        </Text>
        <CheckRow
          label="Enable Jev for model-team roles"
          checked={jevEnabled}
          onPress={() => setJevEnabled(!jevEnabled)}
        />
        <Field
          label={
            settings.jev.configured && !clearJevKey
              ? "Jev API key (configured on server)"
              : "Jev API key"
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
            settings.jev.configured ? "Leave empty to keep stored key" : "Enter server credential"
          }
        />
        {settings.jev.configured && (
          <Button small danger={clearJevKey} onPress={() => setClearJevKey(!clearJevKey)}>
            {clearJevKey ? "Keep saved API key override" : "Clear saved API key override on save"}
          </Button>
        )}
        <Field
          label="Jev model"
          value={jevModel}
          onChangeText={setJevModel}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="jev-latest"
        />
        <View style={{ gap: 8 }}>
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>Failure policy</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {(["closed", "local-budget"] as JevFailMode[]).map((mode) => (
              <Button
                key={mode}
                small
                primary={jevFailMode === mode}
                onPress={() => setJevFailMode(mode)}
              >
                {mode === "closed" ? "Stop when unavailable" : "One local bounded turn"}
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            {jevFailMode === "closed"
              ? "A Jev outage blocks the role instead of running without its configured guardrails."
              : "A Jev outage permits one explicitly recorded, locally bounded turn before stopping."}
          </Text>
        </View>
        <Field
          label="Jev decision timeout (milliseconds, 1000–30000)"
          value={jevTimeoutMs}
          onChangeText={setJevTimeoutMs}
          keyboardType="number-pad"
        />
      </Card>

      <Card style={{ gap: 12, borderWidth: 1, backgroundColor: colors.surfaceMuted }}>
        <View style={[s.between, { gap: 12 }]}>
          <View style={[s.row, { gap: 10, flex: 1 }]}>
            <TerminalSquare size={20} color={colors.blueDark} />
            <Text style={s.heading}>Embedded pi runtime</Text>
          </View>
          <Status label={piEnabled ? "Enabled" : "Off"} ready={piEnabled} />
        </View>
        <Text style={s.small}>
          Pi runs bounded coding turns with the task-snapshotted, server-allowlisted role model. It
          can use the isolated Docker computer and read-only connectors, never the host shell or
          host filesystem.
        </Text>
        <CheckRow
          label="Enable pi for model-team roles"
          checked={piEnabled}
          onPress={() => setPiEnabled(!piEnabled)}
        />
        <Field
          label="Maximum loop iterations (1–8)"
          value={piMaxIterations}
          onChangeText={setPiMaxIterations}
          keyboardType="number-pad"
        />
        <Field
          label="Role timeout (milliseconds, 5000–900000)"
          value={piTimeoutMs}
          onChangeText={setPiTimeoutMs}
          keyboardType="number-pad"
        />
      </Card>

      <ErrorNotice error={error} />
      <Button primary busy={busy} onPress={() => void save()}>
        Save runtime settings
      </Button>
      <Text style={s.small}>Last saved {new Date(settings.updatedAt).toLocaleString()}</Text>
    </Card>
  );
}
