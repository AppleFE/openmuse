import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { UsageService } from "../apps/server/src/usage.ts";
test("usage is owner-scoped, idempotent and separates chats from background tasks",async()=>{
  const db=await createStore({});try{
    const service=new UsageService(db),value={threadId:"chat-1",modelId:"model",input:10,output:20,cacheRead:5,cacheWrite:0,totalTokens:35,durationMs:1000,reported:true,createdAt:new Date().toISOString()};
    await service.record("a","call-1",value);await service.record("a","call-1",value);
    await service.record("a","call-2",{...value,threadId:null});
    await service.record("b","call-1",value);
    const summary=await service.summary("a","chat-1");assert.equal(summary.thread.calls,1);assert.equal(summary.thread.totalTokens,35);assert.equal(summary.allChats.totalTokens,35);assert.equal(summary.all.totalTokens,70);assert.equal(summary.latest?.tokensPerSecond,20);
    assert.equal((await service.summary("unknown")).all.calls,0);
  }finally{await db.close();}
});
