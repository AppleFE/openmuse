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
import { compactSettings } from "./settings-core";
import { Button, Card, colors, ErrorNotice, Field, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const providerIcons = {
  github: Github,
  tailscale: Network,
  headscale: Server,
  wireguard: Shield,
  proxmox: Server,
} satisfies Record<ConnectorProvider, typeof Github>;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultConfig(provider: ConnectorProviderInfo) {
  return Object.fromEntries(
    provider.configFields.map((field) => [field.name, field.name === "verifyTls" ? true : ""]),
  );
}

function displayValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function status(connector: ConnectorView, provider: ConnectorProviderInfo | undefined) {
  if (provider?.secretFields.length && !connector.hasSecret)
    return { label: "Unconfigured", color: colors.muted };
  if (!connector.check) return { label: "Unconfigured", color: colors.muted };
  return connector.check.ok
    ? { label: "Connected", color: colors.success }
    : { label: "Error", color: colors.danger };
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
  if (field.name === "verifyTls") {
    const checked = value !== false;
    return (
      <Pressable
        accessibilityRole="checkbox"
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
          <Text style={s.text}>{field.label}</Text>
          {!!field.description && <Text style={s.small}>{field.description}</Text>}
        </View>
      </Pressable>
    );
  }
  return (
    <View>
      <Field
        label={`${field.label}${field.required ? "" : " (optional)"}`}
        value={displayValue(value)}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={field.name === "ca"}
        placeholder={secret ? "Stored securely on the server" : field.description}
      />
      {!!field.description && !secret && (
        <Text style={[s.small, { marginTop: -10, marginBottom: 14 }]}>{field.description}</Text>
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

  async function save() {
    setBusy(true);
    setError("");
    try {
      const cleanConfig = compactSettings(config);
      const cleanSecrets = compactSettings(secrets);
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

  const configReady = provider.configFields.every(
    (field) => !field.required || config[field.name] !== "",
  );
  const secretsReady =
    !!connector?.hasSecret ||
    provider.secretFields.every((field) => !field.required || !!secrets[field.name]?.trim());

  return (
    <Sheet
      title={`${connector ? "Edit" : "Connect"} ${provider.label}`}
      subtitle={provider.description}
      onClose={onClose}
    >
      <View style={{ gap: 4 }}>
        <Field label="Connection name" value={name} onChangeText={setName} />
        {provider.configFields.map((field) => (
          <ConnectorField
            key={field.name}
            field={field}
            value={config[field.name]}
            onChange={(value) => setConfig((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        {!!provider.secretFields.length && (
          <Card style={{ gap: 4, backgroundColor: colors.surfaceMuted }}>
            <Text style={s.heading}>Credentials</Text>
            <Text style={s.small}>
              {connector?.hasSecret
                ? "Credentials are configured. Leave these fields empty to keep the stored values."
                : "Credentials are sent only to your server and are never returned to this app."}
            </Text>
            {provider.secretFields.map((field) => (
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
          {connector ? "Save connection" : "Create connection"}
        </Button>
      </View>
    </Sheet>
  );
}

export function ConnectorSettings({ query = "" }: { query?: string }) {
  const { api, notify } = useWorkspace();
  const [providers, setProviders] = useState<ConnectorProviderInfo[]>([]);
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
      notify(result.ok ? `${connector.name} connected.` : `${connector.name}: ${result.detail}`);
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
      notify(`${connector.name} removed.`);
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
    `${provider.label} ${provider.description}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <View style={{ gap: 14 }}>
      <SectionHeading title="Infrastructure connections" />
      <Text style={s.muted}>
        Manage dedicated server-side connections. Credentials are write-only and never displayed.
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
                {connector.check.detail}
              </Text>
            )}
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button small busy={busyId === connector.id} onPress={() => void test(connector)}>
                Test connection
              </Button>
              {provider && (
                <Button small onPress={() => setEditing({ provider, connector })}>
                  Edit
                </Button>
              )}
              <Button
                small
                danger
                icon={Trash2}
                busy={busyId === connector.id}
                onPress={() => void remove(connector)}
              >
                {confirmingDelete === connector.id ? "Confirm removal" : "Remove"}
              </Button>
            </View>
          </Card>
        );
      })}
      {!matchingConnectors.length && connectors.length > 0 && (
        <Text style={s.muted}>No configured connections match this search.</Text>
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
              Add {provider.label}
            </Button>
          );
        })}
      </View>
      {!providers.length && !error && <Text style={s.muted}>Loading connector options…</Text>}
      <ErrorNotice error={error} />
      {!!error && <Button onPress={() => void refresh()}>Retry connections</Button>}
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
