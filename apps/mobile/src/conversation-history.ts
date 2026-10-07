import type { MessagesSnapshotEvent } from "@ag-ui/core";

/** Server snapshots already contain the canonical, owner-scoped chronology.
 * AG-UI's default merge keeps local order and appends missing remote messages,
 * which can put an older turn after the reply sent by a stale second client.
 */
export const conversationHistorySubscriber = {
  onMessagesSnapshotEvent: ({ event }: { event: MessagesSnapshotEvent }) => ({
    messages: event.messages,
    stopPropagation: true,
  }),
};
