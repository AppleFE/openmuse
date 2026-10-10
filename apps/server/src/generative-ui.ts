import { createHash } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { generatedUiSchema, parseGeneratedUi } from "../../../packages/domain/src/generative-ui.ts";

export function generatedUiTool() {
  return defineTool({
    name: "generateSandboxedUi",
    description:
      "Create an interactive inline visual answer: charts, diagrams, calculators, simulations or 3D. CSS-first streaming, isolated HTML/CSS/JS, saved in this chat and exportable as HTML. No host or connector actions. Use Korean labels and real, sourced data or explicit example assumptions.",
    parameters: generatedUiSchema,
    execute: async (input) => {
      const value = parseGeneratedUi(input);
      // Code lives in the owner-scoped, durable tool arguments, not duplicated in
      // the tool result/model context. Never execute generated JavaScript here.
      return {
        kind: "generated-ui",
        version: 1,
        digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        title: value.title,
        status: "accepted",
        message:
          "시각화를 대화에 저장했습니다. 브라우저에서 렌더링하며 HTML로 내려받을 수 있습니다.",
      };
    },
  });
}
