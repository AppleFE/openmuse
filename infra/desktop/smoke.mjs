import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";

const { stage } = JSON.parse(await readFile("artifacts/desktop-stage.json", "utf8"));
const fixture = resolve("artifacts/desktop-e2e-harness");
await mkdir(fixture, { recursive: true });
await writeFile(
  `${fixture}/package.json`,
  JSON.stringify({ name: "openmuse-desktop-qa", main: "main.mjs", type: "module" }),
);
await writeFile(
  `${fixture}/main.mjs`,
  String.raw`
import {shell,app} from 'electron';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
app.whenReady().then(async()=>{
const {publicKey,privateKey}=await generateKeyPair('RS256');
const jwk=await exportJWK(publicKey); jwk.kid='desktop-qa'; jwk.alg='RS256';
let authorization; let calls=0; globalThis.desktopQA={calls:0,tool:false,requests:[]};
const actualFetch=globalThis.fetch;
shell.openExternal=async(raw)=>{
 const url=new URL(raw);
 if(url.hostname!=='auth.openai.com')return;
 authorization=url;
 const callback=new URL(url.searchParams.get('redirect_uri'));
 callback.search=new URLSearchParams({state:url.searchParams.get('state'),code:'qa-code',client_id:'oaiapp_desktopqa'});
 await actualFetch(callback);
};
globalThis.fetch=async(input,init={})=>{
 const url=String(input);
 if(url==='https://auth.openai.com/.well-known/jwks.json') return Response.json({keys:[jwk]});
 if(url.endsWith('/api/accounts/oauth/token'))return Response.json({
  access_token:'qa-access',refresh_token:'qa-refresh',expires_in:3600,token_type:'Bearer',scope:'openid chatgpt.tokens.use.direct',
  id_token:await new SignJWT({nonce:authorization.searchParams.get('nonce'),email:'qa@example.invalid'})
    .setProtectedHeader({alg:'RS256',kid:'desktop-qa'}).setSubject('qa-account').setAudience('oaiapp_desktopqa')
    .setIssuer('https://auth.openai.com').setIssuedAt().setExpirationTime('1h').sign(privateKey)
 });
 if(url==='https://api.openai.com/v1/models')return Response.json({models:[{slug:'gpt-desktop-qa',display_name:'Desktop QA model',visibility:'list',input_modalities:['text','image']}]});
 if(url==='https://api.openai.com/v1/responses'){
  const body=JSON.parse(init.body);calls++;globalThis.desktopQA.calls=calls;
  globalThis.desktopQA.requests.push({keys:Object.keys(body),toolNames:body.tools?.flatMap(t=>t.tools||[t]).map(t=>t.name)});
  const result=body.input.find(i=>i.type==='function_call_output');
  let output;
  if(!result){
    const tools=(body.tools||[]).flatMap(t=>t.tools||[t]);
    const tool=tools.find(t=>t.name==='list_connectors')||tools.find(t=>t.name==='agent_status');
    if(!tool)throw Error('QA safe tool unavailable: '+JSON.stringify(tools.map(t=>t.name)));
    output=[{type:'function_call',id:'fc_qa1',call_id:'call_qa1',name:tool.name,namespace:'openmuse',arguments:'{}',status:'completed'}];
  } else {globalThis.desktopQA.tool=true;output=[{type:'message',id:'msg_qa1',role:'assistant',status:'completed',content:[{type:'output_text',text:'DESKTOP_TOOL_ROUNDTRIP_OK',annotations:[]}]}];}
  const response={id:'resp_qa'+calls,status:'completed',output,usage:{input_tokens:40,output_tokens:10,total_tokens:50}};
  const item=output[0];
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,arguments:'',content:[],status:'in_progress'}}];
  if(item.type==='function_call')events.push({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:'{}'},
    {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:'{}'});
  else events.push({type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'DESKTOP_TOOL_ROUNDTRIP_OK'});
  events.push({type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response});
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 }
 if(url.endsWith('/oauth/revoke'))return new Response(null,{status:200});
 return actualFetch(input,init);
};
void import(${JSON.stringify(pathToFileURL(`${stage}/main.mjs`).href)});
});
`,
);
const child = await electron.launch({
  args: [fixture, `--user-data-dir=${resolve(`artifacts/desktop-e2e-data-${Date.now()}`)}`],
  timeout: 70000,
});
child.process().stderr.on("data", (d) => process.stderr.write(d));
try {
  const page = await child.firstWindow({ timeout: 65000 });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.getByText("Continue with ChatGPT", { exact: true }).click();
  await page.getByLabel("OpenMuse에 메시지 보내기").waitFor({ timeout: 45000 });
  console.log("LOGIN_OK", await page.evaluate(() => window.openmuseDesktop.status()));
  await page.getByLabel("OpenMuse에 메시지 보내기").fill("도구로 연결 목록을 확인한 뒤 답해줘.");
  await page.getByLabel("메시지 전송", { exact: true }).click();
  await page.getByText("DESKTOP_TOOL_ROUNDTRIP_OK", { exact: false }).waitFor({ timeout: 60000 });
  console.log("ROUNDTRIP", await child.evaluate(() => globalThis.desktopQA));
  await page.screenshot({ path: "artifacts/desktop-e2e.png" });
  console.log("END_TO_END_OK");
} catch (error) {
  console.log("QA", await child.evaluate(() => globalThis.desktopQA));
  console.log(
    "FAIL_STATE",
    await child
      .firstWindow()
      .then((p) => p.locator("body").innerText())
      .catch(() => ""),
  );
  throw error;
} finally {
  await child.close();
}
