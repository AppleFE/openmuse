/** noVNC renders the owned browser's RFB stream; remote page scripts stay on the worker. */
export function browserConsole(streamUrl: string) {
  const stream = JSON.stringify(streamUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenMuse 공유 브라우저</title>
<style>*{box-sizing:border-box}body{margin:0;background:#151b1e;color:#f1f4f5;font:14px system-ui}header{height:42px;padding:8px 12px;display:flex;gap:12px;align-items:center}button{border:0;border-radius:16px;background:#285e7c;color:white;padding:6px 12px;cursor:pointer}#screen{width:100%;height:calc(100vh - 42px);min-height:240px}#status{flex:1;font-size:12px}#ime{position:absolute;opacity:0;width:1px;height:1px;left:8px;top:40px}#error{position:absolute;top:45px;background:#642c29;padding:12px;display:none;z-index:2}</style>
<header><span id="status" role="status">브라우저 연결 중…</span><button id="control">직접 제어</button><button id="keyboard">키보드</button><button id="full">전체 화면</button></header><div id="error" role="alert"></div><div id="screen" tabindex="0" aria-label="공유 브라우저 화면"></div><textarea id="ime" aria-label="공유 브라우저 키보드" autocomplete="off" autocapitalize="off"></textarea>
<script type="module">import RFB from '/api/novnc/core/rfb.js';
const url=new URL(${stream});url.protocol=location.protocol==='https:'?'wss:':'ws:';url.host=location.host;
const screen=document.querySelector('#screen'),status=document.querySelector('#status'),error=document.querySelector('#error'),ime=document.querySelector('#ime'),control=document.querySelector('#control');
const rfb=new RFB(screen,url.href);rfb.scaleViewport=true;rfb.viewOnly=true;rfb.background='#151b1e';rfb.showDotCursor=true;
function fail(message){error.textContent=message;error.style.display='block';}
async function api(body){const response=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('브라우저 연결이 만료되거나 끊겼습니다. 화면을 다시 여세요.');return response.json();}
async function state(){try{const state=await api({op:'state'});rfb.viewOnly=state.control!=='user';control.textContent=rfb.viewOnly?'직접 제어':'에이전트에게 반환';status.textContent=rfb.viewOnly?'에이전트 제어 · 화면 보기':'사용자 제어 · 화면에서 클릭하고 입력하세요';}catch(e){fail(e.message);}}
control.onclick=async()=>{try{await api({op:'control',control:rfb.viewOnly?'user':'agent'});await state();rfb.focus();}catch(e){fail(e.message);}};
rfb.addEventListener('connect',()=>{error.style.display='none';state();});rfb.addEventListener('disconnect',()=>fail('연결이 종료됐습니다. OpenMuse에서 브라우저를 다시 여세요.'));
document.querySelector('#full').onclick=()=>document.documentElement.requestFullscreen?.();
document.querySelector('#keyboard').onclick=()=>{ime.focus();};
let composing=false;ime.addEventListener('compositionstart',()=>composing=true);ime.addEventListener('compositionend',async()=>{composing=false;const text=ime.value;ime.value='';if(text&&!rfb.viewOnly)try{await api({type:'text',text});}catch(e){fail(e.message);}});
ime.addEventListener('input',async()=>{if(composing||rfb.viewOnly)return;const text=ime.value;ime.value='';if(text)try{await api({type:'text',text});}catch(e){fail(e.message);}});
ime.addEventListener('keydown',e=>{if(composing||e.isComposing||e.keyCode===229)return;if(['Enter','Backspace','Tab','Escape'].includes(e.key)&&!rfb.viewOnly){e.preventDefault();api({type:'key',key:e.key}).catch(e=>fail(e.message));}});
screen.addEventListener('compositionstart',()=>{composing=true;ime.focus();});
screen.addEventListener('keydown',e=>{if(!rfb.viewOnly&&(e.keyCode===229||e.key==='Process'))ime.focus();},true);
document.addEventListener('paste',e=>{if(rfb.viewOnly)return;const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();api({type:'text',text:text.slice(0,10000)}).catch(e=>fail(e.message));}},true);
const timer=setInterval(state,1500);window.addEventListener('pagehide',()=>{clearInterval(timer);rfb.disconnect();});
</script></html>`;
}
