import type { GeneratedUi } from "../../packages/domain/src/generative-ui.ts";

export const interactiveAnswer: GeneratedUi = {
  initialHeight: 300,
  placeholderMessages: ["계산기를 만들고 있습니다."],
  css: ".controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap}output{color:var(--accent);font-size:28px}",
  html: '<h2>복리 계산기</h2><p>예시: 원금 100만원, 연 이율 5%</p><div class="controls"><label for="years">기간(년)</label><input id="years" type="range" min="1" max="30" value="10"><output id="amount"></output></div><button id="follow">현재 조건으로 설명 요청</button>',
  jsFunctions:
    'function update(){document.getElementById("amount").textContent=Math.round(1000000*Math.pow(1.05,Number(document.getElementById("years").value))).toLocaleString("ko-KR")+"원";}',
  jsExpressions: [
    'document.getElementById("years").addEventListener("input",update);update();',
    'document.getElementById("follow").addEventListener("click",()=>Websandbox.connection.remote.sendPrompt({text:document.getElementById("years").value+"년 복리 계산 결과를 설명해줘"}));',
  ],
  title: "복리 계산기",
  libraries: [],
};
