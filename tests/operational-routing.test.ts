import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {routingHarness,bad,sibling,fallback,failure,success} from "./helpers/operational-harness.ts";
import {getOperationalCooldownKey} from "../src/operational-health.ts";

async function open(h:ReturnType<typeof routingHarness>) {
  h.events(failure());
  for(let i=0;i<3;i++) { await h.attempt(); if(i<2)h.advance(180_000); }
  assert.equal(h.cb.getState(h.key(bad)),"open");
}

describe("actual routing operational gate with mocked streams",()=>{
  it("opens on sparse 429s across routes, independently of successful siblings",async()=>{
    const h=routingHarness();
    for(let i=0;i<3;i++) {
      h.events(failure()); const result=await h.attempt(bad,i%2?"b":"a");
      assert.equal(result.operationalFailure,true);
      h.events(success()); assert.equal((await h.attempt(sibling)).success,true);
      assert.equal(h.cb.getFailureCount(h.key(bad)),i+1);
      if(i<2)h.advance(180_000);
    }
    assert.equal(h.cb.getState(h.key(bad)),"open");
    assert.equal(h.healthy("b").some(t=>t.modelId===bad.modelId),false);
    assert.equal(h.healthy("b").some(t=>t.modelId===sibling.modelId),true);
    const calls=h.transportCalls.length;
    assert.equal((await h.attempt(bad,"b")).skipped,true);
    assert.equal(h.transportCalls.length,calls);
  });

  it("isolates configured auth identities even for the same model on the same route",async()=>{
    const h=routingHarness();
    await h.attempt(bad);
    const other={...bad,authProvider:"other-account"};
    h.events(success());assert.equal((await h.attempt(other)).success,true);
    assert.equal(h.cb.getFailureCount(h.key(bad)),1);
    assert.equal(h.cb.getFailureCount(h.key(other)),0);
  });

  it("emits attempt telemetry only after admission, not for skipped candidates",async()=>{
    const h=routingHarness();let admitted=0;
    const onAttempt=()=>{admitted++;};
    await h.attempt(bad,"a",undefined,onAttempt);
    await h.attempt(bad,"a",undefined,onAttempt);
    assert.equal(admitted,1);
    assert.equal(h.transportCalls.length,1);
  });

  it("concurrent shorter errors cannot shorten an existing reason cooldown",async()=>{
    const h=routingHarness();let finish!:()=>void;
    h.setTransport(async function*(){await new Promise<void>(resolve=>{finish=resolve;});yield* failure();});
    const pending=h.attempt();
    h.events(failure("503 overloaded"));await h.attempt();
    const deadline=h.cooldowns.get(getOperationalCooldownKey(bad,"a"))!.until;
    finish();await pending;
    assert.equal(deadline,h.time()+300_000);
    assert.equal(h.cooldowns.get(getOperationalCooldownKey(bad,"a"))!.until,deadline);
    assert.equal(h.cb.dump()[h.key(bad)].retryAt,deadline);
  });

  it("rechecks cooldown at transport even for a stale candidate from another decision",async()=>{
    const h=routingHarness();
    const candidates=h.healthy();
    await h.attempt(bad);
    const calls=h.transportCalls.length;
    assert.equal((await h.attempt(candidates[0])).skipped,true);
    assert.equal(h.transportCalls.length,calls);
    assert.equal(h.cb.getFailureCount(h.key(bad)),1);
  });

  it("single pending recovery probe blocks stale fallback/shadow candidates and other routes",async()=>{
    const h=routingHarness(); await open(h);h.advance(24*60*60_000);
    let finish!:()=>void;
    h.setTransport(async function*(){await new Promise<void>(resolve=>{finish=resolve;});yield* failure();});
    const stale=h.healthy("b");
    const probing=h.attempt();
    const snapshot=h.cb.dump();
    for(let i=0;i<5;i++) {h.healthy("b");h.status();assert.deepEqual(h.cb.dump(),snapshot);}
    assert.equal((await h.attempt(stale[0],"b")).skipped,true);
    assert.equal(h.cb.dump()[h.key(bad)].probeInFlight,true);
    finish();await probing;
    assert.equal(h.cb.getState(h.key(bad)),"open");
    assert.equal(h.cb.dump()[h.key(bad)].retryAt,h.time()+300_000);
    assert.equal(h.cb.getFailureCount(h.key(bad)),4);
    h.events(success());assert.equal((await h.attempt(fallback,"b")).success,true);
  });

  it("successful recovery resets streak and backoff, while long reason deadlines are retained",async()=>{
    const h=routingHarness();await open(h);h.advance(120_000);
    h.events(failure("503 overloaded"));await h.attempt();
    assert.equal(h.cb.dump()[h.key(bad)].retryAt,h.time()+300_000);
    h.advance(300_000);h.events(success());await h.attempt();
    assert.equal(h.cb.getState(h.key(bad)),"closed");
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
    h.events(failure());await h.attempt();
    assert.equal(h.cb.getFailureCount(h.key(bad)),1);
  });

  it("keeps existing missing-credential and model-resolution cooldowns without poisoning health",async()=>{
    const h=routingHarness();h.credentials(false);
    assert.match((await h.attempt()).retryableFailure,/no valid credentials/);
    assert.equal(h.cooldowns.get(getOperationalCooldownKey(bad,"a"))!.until,h.time()+90_000);
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
    h.advance(90_000);h.credentials(true);h.modelError(new Error("unknown model"));
    assert.match((await h.attempt()).retryableFailure,/unknown model/);
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
    assert.equal(h.cooldowns.get(getOperationalCooldownKey(bad,"a"))!.until,h.time()+90_000);
  });

  it("signature/input/auth failures preserve failover but do not escalate operational streaks",async()=>{
    for(const message of ["Missing required thought_signature", "400 invalid_request_error required_field_missing", "401 unauthorized"]) {
      const h=routingHarness();h.events(failure(message));
      for(let i=0;i<3;i++){assert.ok((await h.attempt()).retryableFailure);h.advance(180_000);}
      assert.equal(h.cb.getFailureCount(h.key(bad)),0,message);
      if(message.includes("thought_signature"))assert.equal(h.cooldowns.size,0);
      else assert.ok(h.cooldowns.size>0);
    }
  });

  it("abort during probe releases its permit without a failure/cooldown, then allows recovery",async()=>{
    const h=routingHarness();await open(h);h.advance(120_000);
    const controller=new AbortController();
    let finish!:()=>void;
    h.setTransport(async function*(){await new Promise<void>(resolve=>{finish=resolve;});yield* failure();});
    const before=h.cb.getFailureCount(h.key(bad));
    const probing=h.attempt(bad,"a",controller.signal);controller.abort();finish();await probing;
    assert.equal(h.cb.getFailureCount(h.key(bad)),before);
    assert.equal(h.cb.dump()[h.key(bad)].probeInFlight,false);
    assert.equal(h.cb.getState(h.key(bad)),"half-open");
    h.events(success());assert.equal((await h.attempt()).success,true);
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
  });

  it("unexpected thrown exceptions release probes; operational thrown errors reopen them",async()=>{
    const h=routingHarness();await open(h);h.advance(120_000);
    h.setTransport(()=>{throw new Error("local programmer error");});
    await assert.rejects(h.attempt(),/local programmer error/);
    assert.equal(h.cb.getState(h.key(bad)),"half-open");
    assert.equal(h.cb.dump()[h.key(bad)].probeInFlight,false);
    h.setTransport(()=>{throw new Error("503 upstream unavailable");});
    await assert.rejects(h.attempt(),/503/);
    assert.equal(h.cb.getState(h.key(bad)),"open");
    assert.equal(h.cb.getFailureCount(h.key(bad)),4);
  });

  it("stream exceptions and terminal error messages count once, and partial output stays terminal",async()=>{
    const h=routingHarness();
    h.setTransport(async function*(){throw new Error("429 rate limit");});
    assert.equal((await h.attempt()).operationalFailure,true);
    assert.equal(h.cb.getFailureCount(h.key(bad)),1);
    h.advance(180_000);
    h.events([{type:"done",message:{stopReason:"error",errorMessage:"503 overloaded"}}]);
    assert.equal((await h.attempt()).operationalFailure,true);
    assert.equal(h.cb.getFailureCount(h.key(bad)),2);
    h.advance(300_000);
    h.events([{type:"text_delta"},...failure()]);
    const result=await h.attempt();
    assert.ok(result.terminalError);assert.equal(result.retryableFailure,undefined);
    assert.deepEqual(h.output.slice(-2).map(e=>e.type),["text_delta","error"]);
    assert.equal(h.cb.getFailureCount(h.key(bad)),3);
    assert.equal(h.cb.getState(h.key(bad)),"open");
  });

  it("truncation failover remains outside operational health",async()=>{
    const h=routingHarness();h.events([{type:"done",message:{stopReason:"length"}}]);
    assert.match((await h.attempt()).retryableFailure,/output truncated/);
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
    assert.equal(h.cooldowns.size,0);
  });

  it("reset while a probe runs ignores its late completion",async()=>{
    const h=routingHarness();await open(h);h.advance(120_000);
    let finish!:()=>void;
    h.setTransport(async function*(){await new Promise<void>(resolve=>{finish=resolve;});yield* failure();});
    const probing=h.attempt();h.cb.clear();h.cooldowns.clear();finish();await probing;
    assert.equal(h.cb.getFailureCount(h.key(bad)),0);
    assert.equal(h.cb.getState(h.key(bad)),"closed");
    assert.equal(h.cooldowns.size,0);
  });
});
