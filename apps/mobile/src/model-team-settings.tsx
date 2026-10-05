import { Bot, Check, ChevronDown, Plus, RefreshCw, Trash2, Users } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  AgentTeam,
  AgentTeamRole,
  ModelCatalogStatus,
  ModelProfile,
  TeamInput,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { uiLabel } from "./locale";
import { executionDependencies, modelAvailabilityLabel } from "./settings-core";
import { Button, Card, colors, ErrorNotice, Field, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function modelDetail(model: ModelProfile) {
  const capabilities = model.capabilities.length
    ? ` · ${model.capabilities.map(uiLabel).join(", ")}`
    : "";
  return `${model.provider} · ${model.model}${capabilities}`;
}

function ModelCatalogRefresh() {
  const { api } = useWorkspace();
  const { data, refresh } = useAgentWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = data?.modelCatalog;
  if (!status?.enabled) return null;
  async function sync() {
    setBusy(true);
    setError("");
    try {
      await api.request<{ modelCatalog: ModelCatalogStatus }>("/api/agent/models/refresh", {});
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={[s.row, { flexWrap: "wrap", gap: 10 }]}>
        <Text style={[s.small, { flex: 1, minWidth: 140 }]}>
          {status.lastSyncedAt
            ? `OpenCodex ${status.modelCount}개 · ${new Date(status.lastSyncedAt).toLocaleTimeString("ko-KR")} 갱신`
            : "OpenCodex 모델 목록 확인 중"}
          {` · ${status.refreshIntervalSeconds}초마다 자동 갱신`}
        </Text>
        <Button small icon={RefreshCw} busy={busy} onPress={() => void sync()}>
          모델 목록 새로고침
        </Button>
      </View>
      <ErrorNotice error={error || status.error || ""} />
      {status.state === "error" && (
        <Text style={s.small}>마지막으로 확인한 목록을 유지합니다.</Text>
      )}
    </View>
  );
}

export function ModelChoices({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelProfile[];
  value?: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  return (
    <ScrollView
      style={{ maxHeight: 420 }}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
      keyboardShouldPersistTaps="handled"
    >
      {models.map((model) => {
        const selected = value === model.id;
        const availability = uiLabel(modelAvailabilityLabel(model));
        return (
          <Pressable
            key={model.id}
            accessibilityRole="radio"
            accessibilityLabel={`${model.label}, ${availability.toLowerCase()}`}
            aria-checked={selected}
            accessibilityState={{ checked: selected, disabled: disabled || !model.available }}
            disabled={disabled || !model.available}
            onPress={() => onChange(model.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 14,
              paddingVertical: 11,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: selected ? colors.blueDark : colors.line,
              backgroundColor: selected ? colors.sky : colors.surfaceMuted,
              opacity: model.available ? (pressed ? 0.72 : 1) : 0.48,
            })}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.text, { fontWeight: "600" }]}>{model.label}</Text>
              <Text style={s.small}>{modelDetail(model)}</Text>
              <Text style={[s.small, { color: model.available ? colors.success : colors.danger }]}>
                {availability}
              </Text>
            </View>
            {selected && <Check size={18} color={colors.blueDark} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  label,
  title,
  subtitle,
}: {
  models: ModelProfile[];
  value?: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  label: string;
  title: string;
  subtitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.id === value);
  const search = query.trim().toLowerCase();
  const filtered = models.filter((model) =>
    `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(search),
  );
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled || !models.length}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={({ pressed }) => [
          s.row,
          {
            gap: 8,
            paddingVertical: 9,
            paddingHorizontal: 13,
            minHeight: 38,
            borderRadius: 18,
            backgroundColor: colors.surfaceMuted,
            opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
          },
        ]}
      >
        <Bot size={15} color={colors.muted} />
        <Text numberOfLines={1} style={[s.small, { flexShrink: 1, color: colors.text }]}>
          {selected?.label ?? "서버 기본값"}
        </Text>
        <ChevronDown size={14} color={colors.muted} />
      </Pressable>
      {open && (
        <Sheet title={title} subtitle={subtitle} onClose={() => setOpen(false)}>
          <ModelCatalogRefresh />
          <Field
            label="모델 검색"
            value={query}
            onChangeText={setQuery}
            placeholder="모델 이름 또는 제공자로 검색"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ModelChoices
            models={filtered}
            value={value}
            disabled={disabled}
            onChange={(modelId) => {
              onChange(modelId);
              setOpen(false);
            }}
          />
          {!filtered.length && <Text style={s.muted}>일치하는 모델이 없습니다.</Text>}
        </Sheet>
      )}
    </View>
  );
}

const starterRoles: AgentTeamRole[] = [
  {
    id: "planner",
    label: "플래너",
    kind: "planner",
    modelId: "",
    systemPrompt:
      "요청을 명확하고 검증 가능한 실행 계획으로 나누세요. 사용자에게는 한국어로 설명하세요.",
    dependsOn: [],
  },
  {
    id: "coder",
    label: "코더",
    kind: "coder",
    modelId: "",
    systemPrompt:
      "계획을 구현하고 실제 결과와 검증 내용을 보고하세요. 사용자에게는 한국어로 설명하세요.",
    dependsOn: ["planner"],
  },
  {
    id: "reviewer",
    label: "리뷰어",
    kind: "reviewer",
    modelId: "",
    systemPrompt:
      "구현의 정확성, 안전성과 부족한 검증을 검토하세요. 사용자에게는 한국어로 설명하세요.",
    dependsOn: ["coder"],
  },
];

function TeamEditor({
  team,
  models,
  onClose,
}: {
  team?: AgentTeam;
  models: ModelProfile[];
  onClose: () => void;
}) {
  const { api } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const fallbackModel = models.find((model) => model.available)?.id ?? "";
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [execution, setExecution] = useState<"sequential" | "parallel">(
    team?.execution ?? "sequential",
  );
  const [roles, setRoles] = useState<AgentTeamRole[]>(
    () =>
      team?.roles.map((role) => ({ ...role, dependsOn: [...role.dependsOn] })) ??
      starterRoles.map((role) => ({ ...role, modelId: fallbackModel })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function updateRole(id: string, patch: Partial<AgentTeamRole>) {
    setRoles((current) => current.map((role) => (role.id === id ? { ...role, ...patch } : role)));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const input: TeamInput = {
        name: name.trim(),
        description: description.trim() || undefined,
        execution,
        roles: roles.map((role, index) => ({
          id: role.id,
          label: role.label.trim(),
          kind: role.kind,
          modelId: role.modelId,
          systemPrompt: role.systemPrompt.trim(),
          dependsOn: executionDependencies(
            roles.map((candidate) => candidate.id),
            execution,
          )[index],
        })),
      };
      await api.request(
        team ? `/api/agent/teams/${team.id}` : "/api/agent/teams",
        input,
        team ? "PATCH" : "POST",
      );
      await refresh();
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const valid =
    name.trim() &&
    roles.every(
      (role) =>
        role.label.trim() &&
        role.systemPrompt.trim() &&
        models.some((model) => model.id === role.modelId && model.available),
    );
  return (
    <Sheet
      title={team ? "모델 팀 수정" : "모델 팀 만들기"}
      subtitle="역할마다 사용할 모델과 시스템 프롬프트를 지정하세요."
      onClose={onClose}
      wide
    >
      <View style={{ gap: 18 }}>
        <Field label="팀 이름" value={name} onChangeText={setName} placeholder="구현과 검토" />
        <Field
          label="설명"
          value={description}
          onChangeText={setDescription}
          placeholder="이 팀이 잘하는 작업"
        />
        <View style={{ gap: 8 }}>
          <Text style={s.heading}>실행 방식</Text>
          <View style={[s.row, { gap: 8 }]}>
            {(["sequential", "parallel"] as const).map((mode) => (
              <Button
                key={mode}
                small
                primary={execution === mode}
                onPress={() => setExecution(mode)}
              >
                {mode === "sequential" ? "순차 실행" : "역할 병렬 실행"}
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            {execution === "sequential"
              ? "플래너 → 코더 → 리뷰어 순서로 이전 역할의 결과를 전달합니다."
              : "각 역할을 독립적으로 실행한 뒤 결과를 모읍니다."}
          </Text>
        </View>
        {roles.map((role) => (
          <Card key={role.id} style={{ gap: 12, borderWidth: 1 }}>
            <Text style={s.heading}>{uiLabel(role.kind)}</Text>
            <Field
              label="발언자 이름"
              value={role.label}
              onChangeText={(label) => updateRole(role.id, { label })}
            />
            <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>모델</Text>
            <ModelPicker
              models={models}
              value={role.modelId}
              onChange={(modelId) => updateRole(role.id, { modelId })}
              label={`${uiLabel(role.kind)} 모델 선택`}
              title={`${uiLabel(role.kind)} 모델 선택`}
            />
            <Field
              label="시스템 프롬프트"
              value={role.systemPrompt}
              onChangeText={(systemPrompt) => updateRole(role.id, { systemPrompt })}
              multiline
            />
          </Card>
        ))}
        <ErrorNotice error={error} />
        <Button primary busy={busy} disabled={!valid} onPress={() => void save()}>
          {team ? "팀 저장" : "팀 만들기"}
        </Button>
      </View>
    </Sheet>
  );
}

export function ModelTeamSettings() {
  const { api, open } = useWorkspace();
  const { data, refresh, delegate } = useAgentWorkspace();
  const models = data?.models ?? [];
  const teams = data?.teams ?? [];
  const [editing, setEditing] = useState<AgentTeam | "new">();
  const [confirmingDelete, setConfirmingDelete] = useState<string>();
  const [launchTeamId, setLaunchTeamId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!launchTeamId && teams.length) setLaunchTeamId(teams[0].id);
    else if (launchTeamId && !teams.some((team) => team.id === launchTeamId))
      setLaunchTeamId(teams[0]?.id ?? "");
  }, [launchTeamId, teams]);

  async function selectDefault(modelId: string) {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/agent/model-settings", { modelId }, "PUT");
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(team: AgentTeam) {
    if (confirmingDelete !== team.id) {
      setConfirmingDelete(team.id);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.request(`/api/agent/teams/${team.id}`, undefined, "DELETE");
      setConfirmingDelete(undefined);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        prompt: prompt.trim(),
        kind: "agent",
        teamId: launchTeamId,
        input: {},
      });
      setPrompt("");
      open({ type: "task", taskId: task.id });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 18 }}>
      <Card style={{ gap: 12 }}>
        <SectionHeading title="기본 모델" />
        <Text style={s.muted}>
          {data?.modelCatalog?.enabled
            ? "OpenCodex 모델은 연결된 서버에서 자동으로 가져옵니다."
            : "서버에 설정된 모델 목록입니다."}{" "}
          비활성화됐거나 사용할 수 없는 모델은 선택할 수 없습니다.
        </Text>
        <ModelCatalogRefresh />
        {models.length ? (
          <ModelPicker
            models={models}
            value={data?.modelSelection?.modelId}
            disabled={busy}
            onChange={(modelId) => void selectDefault(modelId)}
            label="기본 모델 선택"
            title="기본 모델 선택"
            subtitle="선택한 모델을 새 대화와 작업의 기본 모델로 사용합니다."
          />
        ) : (
          <Text style={s.muted}>서버에 설정된 모델이 없습니다.</Text>
        )}
        <Text style={s.small}>선택한 모델을 새 대화와 작업의 기본 모델로 사용합니다.</Text>
      </Card>

      <Card style={{ gap: 14 }}>
        <SectionHeading title="모델 팀" />
        <Text style={s.muted}>
          플래너, 코더와 리뷰어의 메시지를 발언자 이름과 함께 작업 대화에 저장합니다.
        </Text>
        {teams.map((team) => (
          <View
            key={team.id}
            style={{
              gap: 8,
              paddingBottom: 14,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <View style={[s.between, { gap: 10 }]}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.heading}>{team.name}</Text>
                <Text style={s.small}>
                  {team.execution === "sequential" ? "순차" : "병렬"} · {team.roles.length} 개 역할
                </Text>
              </View>
              <Button small onPress={() => setEditing(team)}>
                수정
              </Button>
              <Button small danger icon={Trash2} busy={busy} onPress={() => void remove(team)}>
                {confirmingDelete === team.id ? "확인" : "삭제"}
              </Button>
            </View>
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              {team.roles.map((role) => (
                <View key={role.id} style={[s.chip, { backgroundColor: colors.surfaceMuted }]}>
                  <Text style={s.chipText}>
                    {uiLabel(role.label)} · {role.modelId}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ))}
        {!teams.length && <Text style={s.muted}>아직 모델 팀이 없습니다.</Text>}
        <Button
          icon={Plus}
          disabled={!models.some((model) => model.available)}
          onPress={() => setEditing("new")}
        >
          모델 팀 만들기
        </Button>
      </Card>

      {!!teams.length && (
        <Card style={{ gap: 12 }}>
          <SectionHeading title="팀 작업 시작" />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {teams.map((team) => (
              <Button
                key={team.id}
                small
                primary={launchTeamId === team.id}
                onPress={() => setLaunchTeamId(team.id)}
              >
                {team.name}
              </Button>
            ))}
          </View>
          <Field
            label="원하는 결과"
            value={prompt}
            onChangeText={setPrompt}
            multiline
            placeholder="요청한 변경을 구현하고 검증·검토해 주세요"
          />
          <Button
            primary
            icon={Users}
            busy={busy}
            disabled={!launchTeamId || !prompt.trim()}
            onPress={() => void launch()}
          >
            팀 실행
          </Button>
        </Card>
      )}
      <ErrorNotice error={error} />
      {editing && (
        <TeamEditor
          team={editing === "new" ? undefined : editing}
          models={models}
          onClose={() => setEditing(undefined)}
        />
      )}
    </View>
  );
}

export function ConversationModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelProfile[];
  value?: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  if (!models.length) return null;
  return (
    <View style={{ maxWidth: 220, flexShrink: 0 }}>
      <ModelPicker
        models={models}
        value={value}
        onChange={onChange}
        disabled={disabled}
        label="대화 모델 선택"
        title="대화 모델 선택"
        subtitle="이 대화에만 적용됩니다. 새 대화의 기본 모델은 앱 설정에서 변경하세요."
      />
    </View>
  );
}
