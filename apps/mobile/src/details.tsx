import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  CalendarDays,
  Check,
  Clock3,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Globe2,
  Mail as MailIcon,
  Reply,
  RotateCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Text, View } from "react-native";
import {
  type ActionProposal,
  type Artifact,
  type BrowserSession,
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type ProposalInput,
} from "../../../packages/domain/src";
import { proxmoxOperationLabels } from "../../../packages/domain/src/proxmox";
import { remoteOperationLabels } from "../../../packages/domain/src/remote-host";
import { DelegateSheet, NotificationsSheet, TaskDetail } from "./agent-ui";
import BrowserConsole from "./BrowserConsole";
import { browserAddress, browserSite } from "./browser-address";
import { BrowserTabs } from "./browser-tabs";
import { ComputerSheet } from "./computer";
import DateTimeEditor from "./DateTimeEditor";
import { localDateTime, zonedInstant } from "./date-time";
import { HostEventsSheet } from "./host-events";
import { UI_LOCALE, uiLabel } from "./locale";
import PdfReader from "./PdfReader";
import { proxmoxParamLabel } from "./proxmox-core";
import { ProxmoxActionReceipt } from "./proxmox-receipt";
import { RemoteJobReceipt } from "./remote-job-receipt";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { type Detail, useWorkspace } from "./workspace";
export function Details({ detail }: { detail: Detail }) {
  const { close, navigate } = useWorkspace();
  if (detail.type === "computer") return <ComputerSheet />;
  if (detail.type === "task") return <TaskDetail taskId={detail.taskId} />;
  if (detail.type === "delegate") return <DelegateSheet />;
  if (detail.type === "notifications") return <NotificationsSheet />;
  if (detail.type === "host-events") return <HostEventsSheet />;
  if (detail.type === "mail") return <MailDetail mail={detail.mail} />;
  if (detail.type === "email") return <EmailEditor draft={detail.draft} />;
  if (detail.type === "event")
    return <EventEditor event={detail.event} draft={detail.draft} neighbors={detail.neighbors} />;
  if (detail.type === "file") return <FileDetail file={detail.file} />;
  if (detail.type === "review") return <ReviewDetail initial={detail.action} />;
  if (detail.type === "browser") return <BrowserDetail initial={detail.browser} />;
  return (
    <Sheet title="내 워크스페이스" subtitle="모든 일을 위한 여유로운 공간." onClose={close}>
      {[
        { section: "mail" as const, title: "메일", icon: MailIcon },
        { section: "calendar" as const, title: "일정", icon: CalendarDays },
        { section: "browser" as const, title: "브라우저", icon: Globe2 },
        { section: "files" as const, title: "파일", icon: FileText },
        { section: "activity" as const, title: "활동", icon: Clock3 },
        { section: "connections" as const, title: "연결", icon: ShieldCheck },
      ].map((item) => (
        <LinkRow
          key={item.section}
          title={item.title}
          icon={item.icon}
          onPress={() => {
            navigate(item.section);
            close();
          }}
        />
      ))}
    </Sheet>
  );
}
function MailDetail({ mail: m }: { mail: Mail }) {
  const { workspace: w, api, refresh, open, close } = useWorkspace();
  const [error, setError] = useState("");
  const [importing, setImporting] = useState("");
  async function importAttachment(reference: string) {
    setError("");
    setImporting(reference);
    try {
      const file = await api.request<Artifact>("/api/mail/import-attachment", { reference });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting("");
    }
  }
  const [thread, setThread] = useState<Mail[]>([m]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<Mail[]>(`/api/mail/threads/${encodeURIComponent(m.threadId)}`)
      .then((items) => {
        if (active) setThread(items.sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, m.threadId, retry]);
  return (
    <Sheet
      title={m.subject}
      subtitle={`${thread.length}개 메시지가 있는 메일 대화`}
      onClose={close}
    >
      {loading && (
        <View style={[s.row, { gap: 10, paddingBottom: 20 }]}>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={s.muted}>대화를 불러오는 중…</Text>
        </View>
      )}
      {thread.map((message) => (
        <Card key={message.id} style={{ marginBottom: 16 }}>
          <View style={s.between}>
            <View style={{ gap: 4, flex: 1 }}>
              <Text style={s.heading}>{message.sender}</Text>
              <Text style={s.small}>{message.from}</Text>
              <Text style={s.small}>받는 사람: {message.to.join(", ")}</Text>
            </View>
            <Text style={s.small}>
              {dateLabel(message.date)} · {timeLabel(message.date)}
            </Text>
          </View>
          <View style={s.divider} />
          <Text selectable style={[s.text, { lineHeight: 25 }]}>
            {message.body}
          </Text>
          {message.attachments.map((id) => {
            const file = w.files.find((f) => f.id === id);
            return file ? (
              <LinkRow
                key={id}
                title={file.name}
                detail={`${file.pageCount}페이지 · PDF 첨부 파일`}
                icon={FileText}
                onPress={() => open({ type: "file", file })}
              />
            ) : (
              <Button
                key={id}
                busy={importing === id}
                icon={FileText}
                onPress={() => void importAttachment(id)}
              >
                {decodeURIComponent(id.split(":").slice(2).join(":")) || "첨부 파일 열기"}
              </Button>
            );
          })}
        </Card>
      ))}
      <ErrorNotice error={error} />
      {!!error && <Button onPress={() => setRetry(retry + 1)}>대화 새로고침</Button>}
      <Button
        primary
        icon={Reply}
        style={{ alignSelf: "flex-start" }}
        onPress={() =>
          open({
            type: "email",
            draft: {
              to: [m.from],
              subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
              body: "",
              cc: [],
              bcc: [],
              attachmentIds: [],
              threadId: m.threadId,
              replyToMessageId: m.id,
            },
          })
        }
      >
        답장 작성
      </Button>
    </Sheet>
  );
}
function EmailEditor({ draft }: { draft?: Partial<EmailDraft> & { id?: string } }) {
  const { workspace: w, api, refresh, open, close, notify } = useWorkspace();
  const [to, setTo] = useState(draft?.to?.join(", ") || "");
  const [cc, setCc] = useState(draft?.cc?.join(", ") || "");
  const [bcc, setBcc] = useState(draft?.bcc?.join(", ") || "");
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body, setBody] = useState(draft?.body || "");
  const [attachments, setAttachments] = useState(draft?.attachmentIds || []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  function emails(value: string) {
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  async function save(review: boolean) {
    setBusy(review ? "review" : "draft");
    setError("");
    try {
      const parsed = emailDraftSchema.safeParse({
        to: emails(to),
        cc: emails(cc),
        bcc: emails(bcc),
        subject,
        body,
        attachmentIds: attachments,
        threadId: draft?.threadId,
        replyToMessageId: draft?.replyToMessageId,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
        );
      if (review) {
        const action = await api.request<ActionProposal>("/api/actions", {
          kind: "email.send",
          data: parsed.data,
        });
        await refresh();
        open({ type: "review", action });
      } else {
        await api.request("/api/drafts", {
          ...parsed.data,
          ...(draft?.id ? { id: draft.id } : {}),
        });
        await refresh();
        notify("OpenMuse에 초안을 저장했습니다.");
        close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet
      title={draft?.threadId ? "답장 작성" : "새 메일"}
      subtitle={`출처: ${w.profile.email} · OpenMuse에 비공개 저장됨`}
      onClose={close}
    >
      <Field
        label="받는 사람"
        value={to}
        onChangeText={setTo}
        placeholder="person@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Field
            label="참조"
            value={cc}
            onChangeText={setCc}
            placeholder="선택 사항"
            autoCapitalize="none"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label="숨은 참조"
            value={bcc}
            onChangeText={setBcc}
            placeholder="선택 사항"
            autoCapitalize="none"
          />
        </View>
      </View>
      <Field
        label="제목"
        value={subject}
        onChangeText={setSubject}
        placeholder="어떤 내용을 전할까요?"
      />
      <Field
        label="메시지"
        value={body}
        onChangeText={setBody}
        multiline
        placeholder="메시지를 입력하세요…"
        style={{ minHeight: 210 }}
      />
      {w.files.length > 0 && (
        <Card style={{ padding: 16, marginBottom: 18 }}>
          <Text style={[s.heading, { fontSize: 13, marginBottom: 5 }]}>첨부 파일</Text>
          {w.files.map((f) => (
            <CheckRow
              key={f.id}
              checked={attachments.includes(f.id)}
              label={`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`}
              onPress={() =>
                setAttachments(
                  attachments.includes(f.id)
                    ? attachments.filter((id) => id !== f.id)
                    : [...attachments, f.id],
                )
              }
            />
          ))}
        </Card>
      )}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button
          primary
          icon={ShieldCheck}
          busy={busy === "review"}
          disabled={!!busy}
          onPress={() => void save(true)}
        >
          메일 검토
        </Button>
        <Button
          icon={Save}
          busy={busy === "draft"}
          disabled={!!busy}
          onPress={() => void save(false)}
        >
          초안 저장
        </Button>
      </View>
      <Text style={[s.small, { marginTop: 13 }]}>
        전송 전에 받는 사람, 메시지와 첨부 파일을 확인할 수 있습니다.
      </Text>
    </Sheet>
  );
}
function EventEditor({
  event: e,
  draft,
  neighbors,
}: {
  event?: CalendarEvent;
  draft?: EventDraft;
  neighbors?: CalendarEvent[];
}) {
  const seed = e || draft;
  const { workspace: w, api, open, close, refresh } = useWorkspace();
  const initialStart = new Date();
  initialStart.setMinutes(0, 0, 0);
  initialStart.setHours(initialStart.getHours() + 1);
  const [title, setTitle] = useState(seed?.title || "");
  const [start, setStart] = useState(seed?.start || initialStart.toISOString());
  const [end, setEnd] = useState(
    seed?.end || new Date(initialStart.getTime() + 3600000).toISOString(),
  );
  const [allDay, setAllDay] = useState(seed?.allDay || false);
  const [zone, setZone] = useState(
    seed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [location, setLocation] = useState(seed?.location || "");
  const [description, setDescription] = useState(seed?.description || "");
  const [attendees, setAttendees] = useState(seed?.attendees.join(", ") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conflicts = (neighbors || w.events).filter(
    (item) =>
      item.id !== e?.id &&
      Date.parse(start) < Date.parse(item.end) &&
      Date.parse(end) > Date.parse(item.start),
  );
  async function propose(remove = false) {
    setBusy(true);
    setError("");
    try {
      let data: ProposalInput;
      if (remove && e) {
        data = {
          kind: "calendar.delete",
          data: { eventId: e.id, calendarId: e.calendarId, title: e.title },
        };
      } else {
        const parsed = eventDraftSchema.safeParse({
          calendarId: e?.calendarId || draft?.calendarId || "primary",
          title,
          start,
          end,
          allDay,
          timeZone: zone,
          location,
          description,
          attendees: attendees
            .split(/[,;\n]/)
            .map((a) => a.trim())
            .filter(Boolean),
        });
        if (!parsed.success)
          throw new Error(
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
          );
        data = e
          ? { kind: "calendar.update", data: { ...parsed.data, eventId: e.id } }
          : { kind: "calendar.create", data: parsed.data };
      }
      const action = await api.request<ActionProposal>("/api/actions", data);
      await refresh();
      open({ type: "review", action });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={e ? "시간 마련하기" : "기대할 만한 일정"}
      subtitle={e ? "일정을 수정한 뒤 변경 내용을 검토하세요." : "캘린더에 일정을 추가하세요."}
      onClose={close}
    >
      <Field
        label="일정 제목"
        value={title}
        onChangeText={setTitle}
        placeholder="어떤 일을 위한 시간인가요?"
      />
      <CheckRow
        label="종일 일정"
        checked={allDay}
        onPress={() => {
          try {
            if (!allDay) {
              const local = localDateTime(start, zone);
              const endDay = new Date(`${local.date}T12:00:00Z`);
              endDay.setUTCDate(endDay.getUTCDate() + 1);
              setStart(local.date);
              setEnd(endDay.toISOString().slice(0, 10));
            } else {
              setStart(zonedInstant(start, "09:00", zone));
              setEnd(zonedInstant(start, "10:00", zone));
            }
            setAllDay(!allDay);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      <DateTimeEditor
        label="시작"
        value={start}
        onChange={setStart}
        timeZone={zone}
        allDay={allDay}
      />
      <DateTimeEditor label="종료" value={end} onChange={setEnd} timeZone={zone} allDay={allDay} />
      {allDay && (
        <Text style={[s.small, { marginBottom: 15 }]}>
          종료 날짜는 일정의 마지막 날 다음 날입니다.
        </Text>
      )}
      <Field label="시간대" value={zone} onChangeText={setZone} placeholder="America/Los_Angeles" />
      <Field
        label="장소 또는 회의 링크"
        value={location}
        onChangeText={setLocation}
        placeholder="선택 사항"
      />
      <Field
        label="참석자"
        value={attendees}
        onChangeText={setAttendees}
        placeholder="이메일 주소를 쉼표로 구분하세요"
      />
      <Field
        label="메모"
        value={description}
        onChangeText={setDescription}
        multiline
        placeholder="기억할 내용을 입력하세요"
      />
      {!!conflicts.length && (
        <Card style={{ backgroundColor: colors.orange, padding: 16, marginBottom: 16 }}>
          <Text style={s.heading}>시간이 겹칩니다</Text>
          {conflicts.map((c) => (
            <Text key={c.id} style={s.muted}>
              {c.title} · {timeLabel(c.start, c.timeZone)}–{timeLabel(c.end, c.timeZone)}
            </Text>
          ))}
        </Card>
      )}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button primary icon={ShieldCheck} busy={busy} onPress={() => void propose()}>
          검토 {e ? "changes" : "event"}
        </Button>
        {e && (
          <Button icon={Trash2} disabled={busy} danger onPress={() => void propose(true)}>
            삭제 검토
          </Button>
        )}
      </View>
    </Sheet>
  );
}
function ReviewDetail({ initial }: { initial: ActionProposal }) {
  const { workspace: w, api, refresh, close, open } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  const d = action.data;
  const pending = action.status === "awaiting_review";
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    setBusy(true);
    setError("");
    try {
      let next: Detail;
      if (action.kind === "email.send")
        next = { type: "email", draft: emailDraftSchema.parse(action.data) };
      else {
        const draft = eventDraftSchema.parse(action.data);
        if (action.kind === "calendar.update") {
          const eventId = action.data.eventId;
          if (typeof eventId !== "string" || !eventId)
            throw new Error("일정 참조 정보가 없습니다. 일정에서 다시 여세요.");
          next = { type: "event", event: { ...draft, id: eventId } };
        } else next = { type: "event", draft };
      }
      await api.request(`/api/actions/${action.id}/decide`, {
        decision: "deny",
        hash: action.hash,
      });
      await refresh();
      open(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const email = action.kind === "email.send";
  const connector = action.kind === "connector.write";
  const automation = action.kind === "automation.write";
  return (
    <Sheet
      title={pending ? "마지막 확인" : action.title}
      subtitle={
        connector
          ? "표시된 커넥터 연결과 대상에 작업을 실행합니다."
          : w.mode === "sample"
            ? "이 작업은 로컬 워크스페이스 안에서만 처리됩니다."
            : "연결된 계정을 변경하기 전에 작업 내용을 확인하세요."
      }
      onClose={close}
    >
      <View style={[s.row, { gap: 13, marginBottom: 21 }]}>
        <View style={[s.iconBox, { backgroundColor: colors.lavender }]}>
          <ShieldCheck size={22} color={colors.text} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.heading}>{action.title}</Text>
          <Text style={s.small}>{action.kind.replace(".", " · ")}</Text>
        </View>
        <Chip tint={pending ? colors.lavender : colors.green}>
          {connector || automation
            ? {
                awaiting_review: "검토 대기",
                executing: "명령 전송 중",
                succeeded: "요청 접수",
                failed: "실패",
                outcome_unknown: "결과 확인 필요",
                denied: "거절됨",
                cancelled: "취소됨",
                expired: "만료됨",
              }[action.status]
            : action.status.replace(/_/g, " ")}
        </Chip>
      </View>
      <Card style={{ gap: 13 }}>
        <ReviewLine label={connector ? "연결" : "계정"} value={action.account || w.profile.email} />
        {automation ? (
          <>
            <ReviewLine label="화면 세션" value={String(d.sessionId)} />
            <ReviewLine label="실행할 조작" value={JSON.stringify(d.actions, null, 2)} />
          </>
        ) : connector ? (
          <>
            <ReviewLine
              label="작업"
              value={
                remoteOperationLabels[String(d.operation)] ??
                proxmoxOperationLabels[String(d.operation)] ??
                String(d.operation)
              }
            />
            {Object.entries((d.params ?? {}) as Record<string, unknown>)
              .filter(([key]) => key !== "digest")
              .map(([key, value]) => (
                <ReviewLine
                  key={key}
                  label={proxmoxParamLabel(key)}
                  value={typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
                />
              ))}
          </>
        ) : email ? (
          <>
            <ReviewLine label="받는 사람" value={arrayText(d.to)} />
            <ReviewLine label="참조" value={arrayText(d.cc) || "없음"} />
            <ReviewLine label="숨은 참조" value={arrayText(d.bcc) || "없음"} />
            <ReviewLine label="제목" value={String(d.subject || "")} />
            <View style={s.divider} />
            <Text selectable style={[s.text, { lineHeight: 25 }]}>
              {String(d.body || "")}
            </Text>
            <View style={s.divider} />
            <Text style={s.label}>첨부 파일</Text>
            {Array.isArray(d.attachmentIds) && d.attachmentIds.length ? (
              d.attachmentIds.map((id) => {
                const file = w.files.find((f) => f.id === id);
                return (
                  <Text key={String(id)} style={s.text}>
                    {file?.name || String(id)} · 버전 {String(id).slice(-8)}
                  </Text>
                );
              })
            ) : (
              <Text style={s.muted}>첨부 파일 없음</Text>
            )}
          </>
        ) : (
          <>
            <ReviewLine label="일정" value={String(d.title || "")} />
            {action.kind !== "calendar.delete" && (
              <>
                <ReviewLine
                  label="시작"
                  value={
                    d.allDay
                      ? String(d.start || "")
                      : `${dateLabel(String(d.start || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.start || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine
                  label="종료"
                  value={
                    d.allDay
                      ? `${String(d.end || "")} (exclusive)`
                      : `${dateLabel(String(d.end || ""), { year: "numeric", month: "short", day: "numeric", timeZone: String(d.timeZone || "UTC") })} · ${timeLabel(String(d.end || ""), String(d.timeZone || "UTC"))}`
                  }
                />
                <ReviewLine label="시간대" value={String(d.timeZone || "")} />
                <ReviewLine label="종일" value={d.allDay ? "예" : "아니요"} />
                <ReviewLine label="장소" value={String(d.location || "없음")} />
                <ReviewLine label="참석자" value={arrayText(d.attendees) || "나만 참석"} />
                <ReviewLine label="메모" value={String(d.description || "없음")} />
              </>
            )}
            <ReviewLine label="일정" value={String(d.calendarId || "primary")} />
            <Text style={s.small}>
              {action.kind === "calendar.delete"
                ? "일정을 삭제하며 참석자에게 알림이 전송될 수 있습니다."
                : "연결된 캘린더에서 참석자에게 초대나 변경 알림을 보낼 수 있습니다."}
            </Text>
          </>
        )}
      </Card>
      <ErrorNotice error={error || action.error} />
      {!!action.result && !connector && (
        <Card style={{ marginTop: 16, backgroundColor: colors.green, padding: 18 }}>
          <Text selectable style={s.text}>
            {resultSummary(action.result)}
          </Text>
        </Card>
      )}
      {connector &&
        action.result &&
        (String(d.operation).startsWith("host_") ? (
          <RemoteJobReceipt action={action} />
        ) : (
          <ProxmoxActionReceipt action={action} />
        ))}
      {pending ? (
        <>
          <Text style={[s.small, { marginVertical: 17 }]}>
            검토 만료:{" "}
            {new Date(action.expiresAt).toLocaleString(UI_LOCALE, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
            . 승인은 위에 표시된 내용에만 적용됩니다.
          </Text>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Button primary icon={Check} busy={busy} onPress={() => void decide("approve")}>
              {connector
                ? "승인하고 실행"
                : w.mode === "sample"
                  ? "로컬에서 승인"
                  : email
                    ? "승인하고 전송"
                    : "변경 승인"}
            </Button>
            {action.kind !== "calendar.delete" && !connector && !automation && (
              <Button icon={Edit3} disabled={busy} onPress={() => void edit()}>
                세부 내용 수정
              </Button>
            )}
            <Button icon={X} disabled={busy} onPress={() => void decide("deny")}>
              진행하지 않기
            </Button>
          </View>
        </>
      ) : (
        <Button style={{ alignSelf: "flex-start", marginTop: 19 }} onPress={close}>
          완료
        </Button>
      )}
    </Sheet>
  );
}
function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <Text selectable style={s.text}>
        {value}
      </Text>
    </View>
  );
}
function FileDetail({ file: f }: { file: Artifact }) {
  const { api, refresh, open, close } = useWorkspace();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      (f.fields || [])
        .filter((field) => field.type !== "unsupported")
        .map((field) => [
          field.name,
          field.type === "checkbox" ? field.value === "true" || field.value === "Yes" : field.value,
        ]),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = api.url(f.url || `/api/files/${f.id}/content`);
  async function fill() {
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>(`/api/files/${f.id}/fill`, { fields: values });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    setError("");
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(url);
        return;
      }
      const target = `${FileSystem.cacheDirectory}${f.id}.pdf`;
      await FileSystem.downloadAsync(url, target, {
        headers: { Authorization: `Bearer ${api.token}` },
      });
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(target, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
      else throw new Error("이 기기에서는 공유할 수 없습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Sheet
      title={f.name}
      subtitle={`${f.pageCount}페이지 · ${Math.max(1, Math.round(f.size / 1024))} KB · ${f.source}`}
      onClose={close}
      wide
    >
      <PdfReader url={url} token={api.token} pageCount={f.pageCount} />
      <View style={[s.row, { gap: 10, marginVertical: 18, flexWrap: "wrap" }]}>
        <Button icon={Download} onPress={() => void share()}>
          {Platform.OS === "web" ? "열기 / 다운로드" : "저장 또는 공유"}
        </Button>
        <Button
          icon={Send}
          onPress={() => open({ type: "email", draft: { attachmentIds: [f.id] } })}
        >
          메일에 첨부
        </Button>
      </View>
      {f.fields && f.fields.length > 0 && (
        <Card>
          <SectionHeading title="양식 작성" />
          <Text style={[s.muted, { marginBottom: 18 }]}>
            정보를 입력하세요. 저장하면 원본을 유지한 채 새 사본을 만듭니다.
          </Text>
          {f.fields.map((field) =>
            field.type === "unsupported" ? (
              <Text key={field.name} style={s.muted}>
                {field.name} · 지원하지 않는 필드 형식
              </Text>
            ) : field.type === "checkbox" ? (
              <CheckRow
                key={field.name}
                checked={!!values[field.name]}
                label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
                onPress={() => setValues({ ...values, [field.name]: !values[field.name] })}
              />
            ) : (
              <Field
                key={field.name}
                label={field.name.replace(/_/g, " ").replace(/^./, (s) => s.toUpperCase())}
                value={String(values[field.name] || "")}
                onChangeText={(value) => setValues({ ...values, [field.name]: value })}
              />
            ),
          )}
          <Button primary icon={Save} busy={busy} onPress={() => void fill()}>
            작성한 사본 저장
          </Button>
        </Card>
      )}
      <ErrorNotice error={error} />
      <Text style={[s.small, { marginTop: 15 }]}>
        추가됨 {dateLabel(f.createdAt)}
        {f.parentId ? " · 작성한 사본" : ""}
      </Text>
    </Sheet>
  );
}
function BrowserDetail({ initial }: { initial: BrowserSession }) {
  const { workspace: w, api, refresh, close, notify } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const latest = w.browsers.find((b) => b.id === initial.id);
  const browser = {
    ...(latest && latest.updatedAt > local.updatedAt ? latest : local),
    consoleUrl: local.consoleUrl,
    previewUrl: local.previewUrl,
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<BrowserSession>(`/api/browsers/${initial.id}`)
      .then((session) => {
        if (active) {
          setLocal(session);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, initial.id, retry]);
  async function importDownloads() {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        files: Artifact[];
        failures: { name: string; message: string }[];
      }>(`/api/browsers/${browser.id}/import-downloads`, {});
      await refresh();
      if (result.failures.length)
        setError(
          result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"),
        );
      const files = result.files;
      notify(
        files.length
          ? `다운로드한 PDF ${files.length}개를 파일에 추가했습니다.`
          : "이 세션에 새 PDF 다운로드가 없습니다.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(end = false) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<BrowserSession>(
        `/api/browsers/${browser.id}/${end ? "close" : browser.kind === "desktop" || browser.status === "closed" ? "reopen" : "navigate"}`,
        end || browser.kind === "desktop" ? {} : { url: browserAddress(url) },
      );
      setLocal(result);
      setUrl(result.url);
      await refresh();
      if (end) close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={browser.kind === "desktop" ? browser.title : browserSite(browser.url)}
      subtitle={`${uiLabel(browser.status)} · 업데이트: ${timeLabel(browser.updatedAt)}`}
      onClose={close}
      wide
      dock
    >
      <View
        style={[
          s.row,
          {
            gap: 10,
            marginBottom: 16,
            display: browser.kind === "desktop" && browser.status === "active" ? "none" : "flex",
          },
        ]}
      >
        <View style={{ flex: 1, display: browser.kind === "desktop" ? "none" : "flex" }}>
          <Field
            label="웹사이트 주소"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
            onSubmitEditing={() => void mutate()}
          />
        </View>
        <Button primary busy={busy} disabled={loading || !url.trim()} onPress={() => void mutate()}>
          {browser.status === "closed"
            ? "다시 열기"
            : browser.status === "error"
              ? "다시 연결"
              : "이동"}
        </Button>
      </View>
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8, marginVertical: 12, flexWrap: "wrap" }]}>
        <Text style={s.small}>
          {browser.control === "user" ? "사용자가 직접 제어 중" : "에이전트 제어 가능"}
          {browser.connectorId ? " · 원격 호스트" : " · OpenMuse 서버"}
        </Text>
        <Button
          small
          busy={busy}
          onPress={() => {
            setBusy(true);
            setError("");
            void api
              .request<BrowserSession>(`/api/browsers/${browser.id}/control`, {
                control: browser.control === "user" ? "agent" : "user",
              })
              .then(async (value) => {
                setLocal(value);
                await refresh();
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {browser.control === "user" ? "에이전트에게 제어 반환" : "화면 제어 가져오기"}
        </Button>
      </View>
      {!loading && browser.kind !== "desktop" && browser.status === "active" && (
        <BrowserTabs browser={browser} />
      )}
      {loading ? (
        <View style={[s.row, { gap: 10, paddingVertical: 24 }]}>
          {error ? (
            <Button onPress={() => setRetry(retry + 1)}>다시 연결</Button>
          ) : (
            <>
              <ActivityIndicator color={colors.blueDark} />
              <Text style={s.muted}>화면에 연결하는 중…</Text>
            </>
          )}
        </View>
      ) : browser.status === "active" && browser.consoleUrl ? (
        <BrowserConsole url={api.url(browser.consoleUrl)} />
      ) : browser.status === "active" && browser.previewUrl ? (
        <Image
          source={{ uri: api.url(browser.previewUrl) }}
          style={{ width: "100%", height: 450, backgroundColor: colors.canvas }}
          resizeMode="contain"
        />
      ) : (
        <Empty
          icon={Globe2}
          title={browser.status === "closed" ? "닫힌 세션입니다" : "미리 보기를 사용할 수 없습니다"}
          detail={
            browser.kind === "desktop"
              ? browser.desktopMode === "virtual"
                ? "가상 데스크톱은 닫으면 초기화됩니다. 다시 열면 새 환경으로 시작합니다."
                : "호스트 화면 연결이 닫혔습니다. 로그인한 사용자 화면에 다시 연결하세요."
              : browser.status === "closed"
                ? "프로필과 다운로드가 저장됐습니다. 다시 열어 이어서 작업하세요."
                : "다시 연결하여 저장된 브라우저 프로필로 계속하세요."
          }
        />
      )}
      <View style={[s.row, { gap: 10, marginTop: 18, flexWrap: "wrap" }]}>
        {!loading && browser.status === "active" && browser.consoleUrl && (
          <Button
            icon={ExternalLink}
            onPress={() => void Linking.openURL(api.url(browser.consoleUrl || ""))}
          >
            화면을 새 창에서 열기
          </Button>
        )}
        {!loading && (
          <Button icon={RotateCw} disabled={busy} onPress={() => setRetry(retry + 1)}>
            연결 새로고침
          </Button>
        )}
        {!loading && browser.kind !== "desktop" && browser.status !== "closed" && (
          <Button icon={Download} busy={busy} onPress={() => void importDownloads()}>
            다운로드한 PDF 가져오기
          </Button>
        )}
        {!loading && browser.status !== "closed" && (
          <Button icon={X} danger busy={busy} onPress={() => void mutate(true)}>
            세션 닫기
          </Button>
        )}
      </View>
    </Sheet>
  );
}
