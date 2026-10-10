import type { GeneratedUi } from "./generative-ui.ts";

export const uiLibraryUrls = {
  chart: "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.js",
  d3: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
  three: "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  gsap: "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js",
} as const;
const json = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

// Kept in an opaque sandbox on web AND native, including downloaded HTML.
// No raw generated markup is interpolated into this document's parser context.
export function generatedUiDocument(
  value: Partial<GeneratedUi>,
  options: {
    channel: string;
    nonce: string;
    preview?: boolean;
    dark?: boolean;
  },
) {
  const { channel, nonce, preview = false, dark = true } = options;
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(nonce)) throw new Error("Invalid UI nonce");
  const urls = (value.libraries ?? []).map((name) => uiLibraryUrls[name]).filter(Boolean);
  const policy = `default-src 'none'; script-src 'nonce-${nonce}' ${urls.join(" ")}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;
  const payload = json({ value, channel, nonce, preview, urls, threeUrl: uiLibraryUrls.three });
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  :root{color-scheme:${dark ? "dark" : "light"};--bg:${dark ? "#101619" : "#ffffff"};--surface:${dark ? "#202b31" : "#f1f5f9"};--text:${dark ? "#e9f0f4" : "#17242d"};--muted:${dark ? "#abbac4" : "#52636f"};--accent:${dark ? "#77c5ff" : "#12649c"};--border:${dark ? "#394951" : "#d3dee5"}}
  *{box-sizing:border-box}html,body{margin:0;min-height:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}body{padding:16px;overflow-wrap:anywhere}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:7px 12px}input,select,textarea{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}svg,canvas,img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--border);padding:8px;text-align:left}h1,h2,h3{line-height:1.3}a{color:var(--accent)}
  </style></head><body><main id="openmuse-widget"></main><script nonce="${nonce}">
  (() => {
    const {value,channel,nonce,preview,urls,threeUrl}=${payload};
    const postMessage=parent.postMessage.bind(parent);
    const send=(message)=>postMessage({channel,...message},'*');
    const reportError=(error)=>send({type:'error',message:String(error?.message||error||'시각화 실행 오류').slice(0,500)});
    window.addEventListener('error',e=>reportError(e.error||e.message));
    window.addEventListener('unhandledrejection',e=>reportError(e.reason));
    const parsed=new DOMParser().parseFromString(value.html||'','text/html');
    parsed.querySelectorAll('script,style,link,base,meta,iframe,frame,frameset,object,embed').forEach(el=>el.remove());
    parsed.querySelectorAll('*').forEach(el=>{
      for(const attr of [...el.attributes]) {
        const key=attr.name.toLowerCase(), val=attr.value.trim();
        if(key.startsWith('on')||['srcdoc','action','formaction','target','ping','nonce','is'].includes(key)||
          ((key==='href'||key==='xlink:href')&&!val.startsWith('#'))||
          ((key==='src'||key==='poster')&&!/^data:image\\/(png|jpeg|webp|gif|svg\\+xml);/i.test(val))||key==='srcset') el.removeAttribute(attr.name);
      }
    });
    document.getElementById('openmuse-widget').replaceChildren(...parsed.body.childNodes);
    const style=document.createElement('style');style.textContent=value.css||'';document.head.append(style);
    document.addEventListener('submit',e=>e.preventDefault(),true);
    let lastHeight=0;
    const resize=()=>{const height=Math.ceil(document.body.getBoundingClientRect().height);if(height!==lastHeight){lastHeight=height;send({type:'height',height});}};
    new ResizeObserver(resize).observe(document.body);window.addEventListener('load',resize);resize();
    // This bridge offers drafts only. The parent requires a separate, visible
    // user action before sending anything into the authenticated conversation.
    const remote=Object.freeze({sendPrompt:async({text})=>{
      if(preview||typeof text!=='string'||!text.trim()||text.length>4000)throw Error('질문은 1~4,000자로 입력하세요.');
      send({type:'prompt',text:text.trim()});return {status:'draft',message:'채팅의 보내기 버튼으로 확인하세요.'};
    }});
    Object.defineProperty(window,'Websandbox',{value:Object.freeze({connection:Object.freeze({remote})}),writable:false});
    if(preview){document.body.style.pointerEvents='none';return;}
    const script=(code)=>{const el=document.createElement('script');el.nonce=nonce;el.textContent=code;document.body.append(el);};
    const load=url=>new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=url;el.crossOrigin='anonymous';el.onload=resolve;el.onerror=()=>reject(Error('시각화 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'));document.head.append(el);});
    (async()=>{
      for(const url of urls){if(url===threeUrl)window.THREE=await import(url);else await load(url);}
      script(value.jsFunctions||'');for(const expression of value.jsExpressions||[])script(expression);
      resize();send({type:'ready'});
    })().catch(reportError);
  })();
  </script></body></html>`;
}

// Native WebView and exported files keep the same inner iframe boundary; never
// run model code in the document that owns the native/host message bridge.
export function generatedUiWrapper(document: string, channel: string, native = false) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenMuse 시각화</title><style>html,body{margin:0;background:#101619;color:#e9f0f4;font:15px system-ui}iframe{display:block;border:0;width:100%;height:100vh}#note{padding:12px;display:none}</style></head><body><iframe title="OpenMuse 대화형 시각화" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><p id="note"></p><script>
  const frame=document.querySelector('iframe');
  addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.data?.channel!==${json(channel)})return;
    ${native ? "window.ReactNativeWebView.postMessage(JSON.stringify(e.data));" : "if(e.data.type==='prompt'){const note=document.getElementById('note');note.textContent='OpenMuse 채팅에서 이어서 질문하세요: '+String(e.data.text).slice(0,4000);note.style.display='block';}"}
  });frame.srcdoc=${json(document)};
  </script></body></html>`;
}
