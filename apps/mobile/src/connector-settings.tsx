import { Github, Network, Server, Shield, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import type {
  ConnectorCheck,
  ConnectorFieldInfo,
  ConnectorProvider,
  ConnectorProviderInfo,
  ConnectorView,
} from "../../../packages/domain/src/connectors";
import { connectorCheckLabel, uiLabel } from "./locale";
import { ProxmoxManager } from "./proxmox-manager";
import { RemoteHostManager } from "./remote-host-manager";
import { compactSettings } from "./settings-core";
import { Button, Card, colors, ErrorNotice, Field, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const providerIcons = {
  github: Github,
  tailscale: Network,
  headscale: Server,
  wireguard: Shield,
  proxmox: Server,
  remote_host: Server,
} satisfies Record<ConnectorProvider, typeof Github>;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultConfig(provider: ConnectorProviderInfo) {
  return Object.fromEntries(
    provider.configFields.map((field) => [
      field.name,
      field.type === "boolean"
        ? field.name === "verifyTls"
        : field.name === "mode"
          ? "agent"
          : field.name === "platform"
            ? "linux"
            : "",
    ]),
  );
}

function displayValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function status(connector: ConnectorView, provider: ConnectorProviderInfo | undefined) {
  if (provider?.secretFields.length && !connector.hasSecret)
    return { label: "설정 안 됨", color: colors.muted };
  if (!connector.check) return { label: "설정 안 됨", color: colors.muted };
  return connector.check.ok
    ? { label: "연결됨", color: colors.success }
    : { label: "오류", color: colors.danger };
}

function ConnectorField({
  field,
  value,
  onChange,
  secret,
}: {
  field: ConnectorFieldInfo;
  value: unknown;
  onChange: (value: string | boolean) => void;
  secret?: boolean;
}) {
  if (field.enum)
    return (
      <View style={{ gap: 8, marginBottom: 16 }}>
        <Text style={s.label}>{uiLabel(field.label)}</Text>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {field.enum.map((option) => (
            <Button key={option} small primary={value === option} onPress={() => onChange(option)}>
              {(
                {
                  agent: "Host Agent",
                  ssh: "SSH",
                  linux: "Linux",
                  windows: "Windows",
                  macos: "macOS",
                } as Record<string, string>
              )[option] ?? option}
            </Button>
          ))}
        </View>
      </View>
    );
  if (field.name === "verifyTls") {
    const checked = value !== false;
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={uiLabel(field.label)}
        aria-checked={checked}
        accessibilityState={{ checked }}
        onPress={() => onChange(!checked)}
        style={[s.row, { gap: 10, paddingVertical: 8 }]}
      >
        <View
          style={{
            width: 42,
            height: 25,
            borderRadius: 14,
            padding: 3,
            alignItems: checked ? "flex-end" : "flex-start",
            backgroundColor: checked ? colors.blueDark : colors.lineStrong,
          }}
        >
          <View style={{ width: 19, height: 19, borderRadius: 10, backgroundColor: colors.card }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.text}>{uiLabel(field.label)}</Text>
          {!!field.description && <Text style={s.small}>{uiLabel(field.description)}</Text>}
        </View>
      </Pressable>
    );
  }
  return (
    <View>
      <Field
        label={`${uiLabel(field.label)}${field.required ? "" : " (선택)"}`}
        value={displayValue(value)}
        onChangeText={onChange}
        secureTextEntry={secret && field.name !== "privateKey"}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={field.name === "ca" || field.name === "privateKey"}
        placeholder={
          secret
            ? "서버에 안전하게 저장됩니다"
            : field.name === "ca"
              ? "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
              : uiLabel(field.description ?? "")
        }
      />
      {!!field.description && !secret && (
        <Text style={[s.small, { marginTop: -10, marginBottom: 14 }]}>
          {uiLabel(field.description)}
        </Text>
      )}
    </View>
  );
}

function ConnectorEditor({
  provider,
  connector,
  onSaved,
  onClose,
}: {
  provider: ConnectorProviderInfo;
  connector?: ConnectorView;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { api } = useWorkspace();
  const [name, setName] = useState(connector?.name ?? provider.label);
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({
    ...defaultConfig(provider),
    ...(connector?.config ?? {}),
  }));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remote = provider.provider === "remote_host";
  const ssh = config.mode === "ssh";
  const configFields = provider.configFields
    .filter(
      (field) =>
        !remote ||
        (ssh
          ? field.name !== "baseUrl"
          : !["host", "port", "username", "hostFingerprint", "platform"].includes(field.name)),
    )
    .map((field) =>
      remote &&
      (ssh
        ? ["host", "username", "hostFingerprint"].includes(field.name)
        : field.name === "baseUrl")
        ? { ...field, required: true }
        : field,
    );
  const secretFields = provider.secretFields
    .filter((field) => !remote || (ssh ? field.name !== "token" : field.name === "token"))
    .map((field) =>
      remote && ["privateKey", "token"].includes(field.name) ? { ...field, required: true } : field,
    );
  const keepSecret = !!connector?.hasSecret && (!remote || connector.config.mode === config.mode);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const cleanConfig = compactSettings(config);
      const cleanSecrets = compactSettings(
        Object.fromEntries(secretFields.map((field) => [field.name, secrets[field.name]])),
      );
      if (connector) {
        await api.request(
          `/api/connectors/${connector.id}`,
          {
            name: name.trim(),
            config: cleanConfig,
            ...(Object.keys(cleanSecrets).length ? { secrets: cleanSecrets } : {}),
          },
          "PATCH",
        );
      } else {
        await api.request("/api/connectors", {
          provider: provider.provider,
          name: name.trim(),
          config: cleanConfig,
          ...(provider.secretFields.length ? { secrets: cleanSecrets } : {}),
        });
      }
      setSecrets({});
      await onSaved();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const configReady = configFields.every((field) => !field.required || config[field.name] !== "");
  const secretsReady =
    keepSecret || secretFields.every((field) => !field.required || !!secrets[field.name]?.trim());

  return (
    <Sheet
      title={`${connector ? "수정" : "연결"} ${provider.label}`}
      subtitle={uiLabel(provider.description)}
      onClose={onClose}
    >
      <View style={{ gap: 4 }}>
        <Field label="연결 이름" value={name} onChangeText={setName} />
        {configFields.map((field) => (
          <ConnectorField
            key={field.name}
            field={field}
            value={config[field.name]}
            onChange={(value) => setConfig((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        {!!provider.secretFields.length && (
          <Card style={{ gap: 4, backgroundColor: colors.surfaceMuted }}>
            <Text style={s.heading}>인증 정보</Text>
            <Text style={s.small}>
              {keepSecret
                ? "인증 정보가 설정되어 있습니다. 기존 값을 유지하려면 비워 두세요."
                : "인증 정보는 서버로만 전송되며 앱에 다시 반환되지 않습니다."}
            </Text>
            {secretFields.map((field) => (
              <ConnectorField
                key={field.name}
                field={field}
                value={secrets[field.name] ?? ""}
                onChange={(value) =>
                  setSecrets((current) => ({ ...current, [field.name]: String(value) }))
                }
                secret
              />
            ))}
          </Card>
        )}
        <ErrorNotice error={error} />
        <Button
          primary
          busy={busy}
          disabled={!name.trim() || !configReady || !secretsReady}
          onPress={() => void save()}
        >
          {connector ? "연결 저장" : "연결 만들기"}
        </Button>
      </View>
    </Sheet>
  );
}

export function ConnectorSettings({ query = "" }: { query?: string }) {
  const { api, notify } = useWorkspace();
  const [providers, setProviders] = useState<ConnectorProviderInfo[]>([]);
  const [managing, setManaging] = useState<ConnectorView>();
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [editing, setEditing] = useState<{
    provider: ConnectorProviderInfo;
    connector?: ConnectorView;
  }>();
  const [confirmingDelete, setConfirmingDelete] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [providerResult, connectorResult] = await Promise.all([
        api.request<{ providers: ConnectorProviderInfo[] }>("/api/connectors/providers"),
        api.request<{ connectors: ConnectorView[] }>("/api/connectors"),
      ]);
      setProviders(providerResult.providers);
      setConnectors(connectorResult.connectors);
      setError("");
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  async function test(connector: ConnectorView) {
    setBusyId(connector.id);
    setError("");
    try {
      const result = await api.request<ConnectorCheck>(`/api/connectors/${connector.id}/test`, {});
      await refresh();
      notify(
        result.ok
          ? `${connector.name} 연결됨.`
          : `${connector.name}: ${connectorCheckLabel(result.detail)}`,
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(connector: ConnectorView) {
    if (confirmingDelete !== connector.id) {
      setConfirmingDelete(connector.id);
      return;
    }
    setBusyId(connector.id);
    setError("");
    try {
      await api.request(`/api/connectors/${connector.id}`, undefined, "DELETE");
      setConfirmingDelete(undefined);
      await refresh();
      notify(`${connector.name} 삭제됨.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyId(undefined);
    }
  }

  const matchingConnectors = connectors.filter((connector) => {
    const provider = providers.find((item) => item.provider === connector.provider);
    return `${connector.name} ${provider?.label ?? connector.provider}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });
  const matchingProviders = providers.filter((provider) =>
    `${provider.label} ${uiLabel(provider.description)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <View style={{ gap: 14 }}>
      <SectionHeading title="인프라 연결" />
      <Text style={s.muted}>
        서버의 연결을 관리합니다. 인증 정보는 입력만 가능하며 표시되지 않습니다.
      </Text>
      {matchingConnectors.map((connector) => {
        const provider = providers.find((item) => item.provider === connector.provider);
        const state = status(connector, provider);
        const Icon = providerIcons[connector.provider];
        return (
          <Card key={connector.id} style={{ gap: 11, borderWidth: 1 }}>
            <View style={[s.row, { gap: 12 }]}>
              <View style={s.iconBox}>
                <Icon size={20} color={colors.blueDark} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.heading}>{connector.name}</Text>
                <Text style={s.small}>{provider?.label ?? connector.provider}</Text>
              </View>
              <Text style={[s.small, { color: state.color, fontWeight: "700" }]}>
                {state.label}
              </Text>
            </View>
            {!!connector.check && (
              <Text style={[s.small, { color: connector.check.ok ? colors.muted : colors.danger }]}>
                {connectorCheckLabel(connector.check.detail)}
              </Text>
            )}
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button small busy={busyId === connector.id} onPress={() => void test(connector)}>
                연결 테스트
              </Button>
              {provider && (
                <Button small onPress={() => setEditing({ provider, connector })}>
                  수정
                </Button>
              )}
              {["proxmox", "remote_host"].includes(connector.provider) && (
                <Button small onPress={() => setManaging(connector)}>
                  관리
                </Button>
              )}
              <Button
                small
                danger
                icon={Trash2}
                busy={busyId === connector.id}
                onPress={() => void remove(connector)}
              >
                {confirmingDelete === connector.id ? "삭제 확인" : "삭제"}
              </Button>
            </View>
          </Card>
        );
      })}
      {!matchingConnectors.length && connectors.length > 0 && (
        <Text style={s.muted}>검색 조건에 맞는 연결이 없습니다.</Text>
      )}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {matchingProviders.map((provider) => {
          const Icon = providerIcons[provider.provider];
          return (
            <Button
              key={provider.provider}
              small
              icon={Icon}
              onPress={() => setEditing({ provider })}
            >
              추가 {provider.label}
            </Button>
          );
        })}
      </View>
      {!providers.length && !error && <Text style={s.muted}>커넥터 옵션을 불러오는 중…</Text>}
      <ErrorNotice error={error} />
      {managing?.provider === "proxmox" && (
        <ProxmoxManager connector={managing} onClose={() => setManaging(undefined)} />
      )}
      {managing?.provider === "remote_host" && (
        <RemoteHostManager connector={managing} onClose={() => setManaging(undefined)} />
      )}
      {!!error && <Button onPress={() => void refresh()}>연결 다시 시도</Button>}
      {editing && (
        <ConnectorEditor
          provider={editing.provider}
          connector={editing.connector}
          onSaved={refresh}
          onClose={() => setEditing(undefined)}
        />
      )}
    </View>
  );
}
