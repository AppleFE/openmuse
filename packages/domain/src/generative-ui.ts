import { z } from "zod";

// Compatible with Open Intelligent UI's CSS-first generateSandboxedUi contract.
export const generatedUiSchema = z.object({
  initialHeight: z.number().int().min(160).max(1200),
  placeholderMessages: z.array(z.string().max(120)).max(6),
  css: z.string().max(24000),
  html: z.string().min(1).max(64000),
  jsFunctions: z.string().max(40000),
  jsExpressions: z.array(z.string().max(12000)).max(16),
  title: z.string().trim().min(1).max(120),
  libraries: z.array(z.enum(["chart", "d3", "three", "gsap"])).max(4),
});
export type GeneratedUi = z.infer<typeof generatedUiSchema>;
export const generatedUiLimit = 160000;
export function parseGeneratedUi(value: unknown): GeneratedUi {
  const parsed = generatedUiSchema.parse(value);
  if (JSON.stringify(parsed).length > generatedUiLimit)
    throw new Error("시각화는 합계 160,000자까지 만들 수 있습니다. 내용을 나누어 주세요.");
  return parsed;
}

export const generatedUiInstructions = `
OpenMuse supports Open Intelligent UI through generateSandboxedUi in this chat, with any selected tool-capable model. Use it when a chart, visual explanation, interactive calculator, diagram, animation, simulation, game or 3D scene materially helps, or when the user asks for an interactive answer. Simple facts, prose and code can remain text; simple tables can use Markdown. Do not create a remote browser, shell app or external website just to show an inline visualization.
Call generateSandboxedUi with parameters in this order: initialHeight, placeholderMessages, css, html, jsFunctions, jsExpressions, title, libraries. The UI previews while streaming; behavior runs after validation. Supply a complete new widget per call; previous widgets stay in conversation history. Use concise Korean labels, accessible labeled inputs, responsive layouts, legible contrast, and label data sources, units and assumptions. Never fabricate live measurements. Obtain data with the existing authorized tools first when needed.
html is a body fragment (HTML/SVG), css is separate. Do not include script/style/link/iframe tags, inline event handlers, external resources or a whole HTML document. Use native SVG/Canvas for simple visuals. Optional libraries (pinned versions, loaded before your code): chart exposes Chart, d3 exposes d3, three exposes THREE, gsap exposes gsap. List only those needed in libraries; [] uses no CDN. jsFunctions is plain JavaScript defining functions and handlers; jsExpressions is an array of initialization statements executed in order. No imports, eval, top-level await or React/JSX. Use an async function if necessary. Wait for DOM elements, handle resize, and use requestAnimationFrame for animations. Available CSS variables: --bg, --surface, --text, --muted, --accent, --border.
This isolated UI has no cookies, storage, host filesystem, OpenMuse API, connector tokens, shell or general network access. Local controls update locally without calling the model. For an explicit follow-up button use await Websandbox.connection.remote.sendPrompt({text: 'question including current selected values'}); the host shows this as a draft for the user to send. Do not call it on load, on a timer, or claim it already sent. It cannot approve actions. Tool success means code was accepted for display, not that browser rendering has been verified. Briefly explain how to use the widget instead of repeating its source code.
`;

export const generatedUiMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("height"), height: z.number().finite().min(0).max(100000) }),
  z.object({ type: z.literal("prompt"), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("error"), message: z.string().max(500) }),
  z.object({ type: z.literal("ready") }),
]);
export type GeneratedUiMessage = z.infer<typeof generatedUiMessageSchema>;
