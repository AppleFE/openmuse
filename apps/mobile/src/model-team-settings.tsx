import { Bot, Plus, Trash2, Users } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  AgentTeam,
  AgentTeamRole,
  ModelProfile,
  TeamInput,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { executionDependencies, modelAvailabilityLabel } from "./settings-core";
import { Button, Card, colors, ErrorNotice, Field, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function modelDetail(model: ModelProfile) {
  const capabilities = model.capabilities.length ? ` · ${model.capabilities.join(", ")}` : "";
  return `${model.provider} · ${model.model}${capabilities}`;
}

export function ModelChoices({
  models,
  value,
  onChange,
  disabled,
  compact,
}: {
  models: ModelProfile[];
  value?: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
      keyboardShouldPersistTaps="handled"
    >
      {models.map((model) => {
        const selected = value === model.id;
        const availability = modelAvailabilityLabel(model);
        return (
          <Pressable
            key={model.id}
            accessibilityRole="radio"
            accessibilityLabel={`${model.label}, ${availability.toLowerCase()}`}
            accessibilityState={{ checked: selected, disabled: disabled || !model.available }}
            disabled={disabled || !model.available}
            onPress={() => onChange(model.id)}
            style={({ pressed }) => ({
              minWidth: compact ? undefined : 170,
              maxWidth: compact ? 190 : 260,
              paddingHorizontal: compact ? 12 : 14,
              paddingVertical: compact ? 8 : 11,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: selected ? colors.blueDark : colors.line,
              backgroundColor: selected ? colors.sky : colors.surfaceMuted,
              opacity: model.available ? (pressed ? 0.72 : 1) : 0.48,
            })}
          >
            <Text
              numberOfLines={1}
              style={[s.text, { fontSize: compact ? 12 : 14, fontWeight: "600" }]}
            >
              {model.label}
            </Text>
            {!compact && <Text style={s.small}>{modelDetail(model)}</Text>}
            <Text style={[s.small, { color: model.available ? colors.success : colors.danger }]}>
              {availability}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const starterRoles: AgentTeamRole[] = [
  {
    id: "planner",
    label: "Planner",
    kind: "planner",
    modelId: "",
    systemPrompt: "Break the request into a clear, verifiable implementation plan.",
    dependsOn: [],
  },
  {
    id: "coder",
    label: "Coder",
    kind: "coder",
    modelId: "",
    systemPrompt: "Implement the plan carefully and report concrete outputs and checks.",
    dependsOn: ["planner"],
  },
  {
    id: "reviewer",
    label: "Reviewer",
    kind: "reviewer",
    modelId: "",
    systemPrompt: "Review the implementation for correctness, safety, and missing verification.",
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
      title={team ? "Edit model team" : "Create model team"}
      subtitle="Assign a model and durable system prompt to every role."
      onClose={onClose}
      wide
    >
      <View style={{ gap: 18 }}>
        <Field
          label="Team name"
          value={name}
          onChangeText={setName}
          placeholder="Build and review"
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="What this group is best at"
        />
        <View style={{ gap: 8 }}>
          <Text style={s.heading}>Execution</Text>
          <View style={[s.row, { gap: 8 }]}>
            {(["sequential", "parallel"] as const).map((mode) => (
              <Button
                key={mode}
                small
                primary={execution === mode}
                onPress={() => setExecution(mode)}
              >
                {mode === "sequential" ? "Sequential handoff" : "Parallel roles"}
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            {execution === "sequential"
              ? "Planner → coder → reviewer; each role receives the previous result."
              : "All roles start independently and their results are collected together."}
          </Text>
        </View>
        {roles.map((role) => (
          <Card key={role.id} style={{ gap: 12, borderWidth: 1 }}>
            <Text style={s.heading}>{role.kind[0].toUpperCase() + role.kind.slice(1)}</Text>
            <Field
              label="Speaker label"
              value={role.label}
              onChangeText={(label) => updateRole(role.id, { label })}
            />
            <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Model</Text>
            <ModelChoices
              models={models}
              value={role.modelId}
              onChange={(modelId) => updateRole(role.id, { modelId })}
            />
            <Field
              label="System prompt"
              value={role.systemPrompt}
              onChangeText={(systemPrompt) => updateRole(role.id, { systemPrompt })}
              multiline
            />
          </Card>
        ))}
        <ErrorNotice error={error} />
        <Button primary busy={busy} disabled={!valid} onPress={() => void save()}>
          {team ? "Save team" : "Create team"}
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
        <SectionHeading title="Models" />
        <Text style={s.muted}>
          This catalog comes from your server. Disabled models and models missing a server key stay
          visible but cannot be selected.
        </Text>
        {models.length ? (
          <ModelChoices
            models={models}
            value={data?.modelSelection?.modelId}
            disabled={busy}
            onChange={(modelId) => void selectDefault(modelId)}
          />
        ) : (
          <Text style={s.muted}>No models are configured on this server.</Text>
        )}
        <Text style={s.small}>The selected model is the default for new chats and tasks.</Text>
      </Card>

      <Card style={{ gap: 14 }}>
        <SectionHeading title="Model teams" />
        <Text style={s.muted}>
          Planner, coder, and reviewer messages are saved with their speaker labels in the task
          thread.
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
                  {team.execution === "sequential" ? "Sequential" : "Parallel"} ·{" "}
                  {team.roles.length} roles
                </Text>
              </View>
              <Button small onPress={() => setEditing(team)}>
                Edit
              </Button>
              <Button small danger icon={Trash2} busy={busy} onPress={() => void remove(team)}>
                {confirmingDelete === team.id ? "Confirm" : "Remove"}
              </Button>
            </View>
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              {team.roles.map((role) => (
                <View key={role.id} style={[s.chip, { backgroundColor: colors.surfaceMuted }]}>
                  <Text style={s.chipText}>
                    {role.label} · {role.modelId}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ))}
        {!teams.length && <Text style={s.muted}>No model teams yet.</Text>}
        <Button
          icon={Plus}
          disabled={!models.some((model) => model.available)}
          onPress={() => setEditing("new")}
        >
          Create model team
        </Button>
      </Card>

      {!!teams.length && (
        <Card style={{ gap: 12 }}>
          <SectionHeading title="Launch a team task" />
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
            label="Outcome"
            value={prompt}
            onChangeText={setPrompt}
            multiline
            placeholder="Build, verify, and review the requested change"
          />
          <Button
            primary
            icon={Users}
            busy={busy}
            disabled={!launchTeamId || !prompt.trim()}
            onPress={() => void launch()}
          >
            Launch team
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
    <View style={{ gap: 5, paddingHorizontal: 5, paddingBottom: 8 }}>
      <View style={[s.row, { gap: 6 }]}>
        <Bot size={13} color={colors.muted} />
        <Text style={s.small}>Model for this conversation</Text>
      </View>
      <ModelChoices models={models} value={value} onChange={onChange} disabled={disabled} compact />
    </View>
  );
}
