import type { GeneratedUiMessage } from "../../../packages/domain/src/generative-ui";

export interface GeneratedUiFrameProps {
  document: string;
  channel: string;
  title: string;
  height: number;
  onMessage: (message: GeneratedUiMessage) => void;
}
