import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { CircuitBreaker } from "../../src/circuit-breaker.ts";
import { getOperationalTargetKey, getOperationalCooldownKey, isOperationalFailure } from "../../src/operational-health.ts";
import { getTargetKey, getCooldownMs } from "../../src/display.ts";
import { shouldFailOverThoughtSignatureError } from "../../src/signature-failover.ts";
import { isTruncatedStop, truncatedStopMessage } from "../../src/terminal-stop.ts";

export type Target = {provider: string; modelId: string; label: string; authProvider?: string};
export type Event = {type: string; error?: {errorMessage: string}; message?: {stopReason: string; errorMessage?: string}};
export const bad: Target = {provider:"mistral",modelId:"small",label:"bad"};
export const sibling: Target = {provider:"mistral",modelId:"medium",label:"sibling"};
export const fallback: Target = {provider:"fallback",modelId:"good",label:"fallback"};
export const failure = (message = "429 Rate limit exceeded"): Event[] => [{type:"error",error:{errorMessage:message}}];
export const success = (): Event[] => [{type:"done",message:{stopReason:"stop"}}];

// Compile then execute the actual private routing functions with mocked auth,
// transport and UI. No extension startup, credential read or network request.
const source = ts.transpileModule(readFileSync(new URL("../../index.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
function extract(name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`Missing function ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  const chunk = source.slice(start, next < 0 ? undefined : start + 1 + next);
  return chunk.slice(0, chunk.lastIndexOf("\n}") + 2);
}

export function routingHarness() {
  let now = 1_000_000;
  const cb = new CircuitBreaker({now:()=>now});
  const cooldowns = new Map<string, {until:number;reason:string}>();
  const transportCalls: Target[] = [];
  const output: Event[] = [];
  let transport: (target: Target) => AsyncIterable<Event> = async function* () { yield* failure(); };
  let credentials = true;
  let modelError: Error | undefined;
  const sandbox: any = {
    Date:{now:()=>now}, Map, Set, String, Error, circuitBreaker:cb, cooldowns,
    getOperationalTargetKey, getOperationalCooldownKey, isOperationalFailure, getTargetKey, getCooldownMs,
    shouldFailOverThoughtSignatureError, isTruncatedStop, truncatedStopMessage,
    routesCache:{a:{targets:[bad,sibling,fallback]},b:{targets:[bad,sibling,fallback]}},
    AUTH_PATH:"mock",readAuthFile:()=>({}),resolveTargetApiKey:()=>"FAKE",
    hasUsableTargetCredentials:()=>credentials,
    activeTargetByRoute:new Map(),lastAttemptByRoute:new Map(),refreshStatus:()=>{},
    describeTarget:(t:Target)=>t.label,cacheOptimizerRouting:{publish:()=>{}},
    getInnerModel:(t:Target)=>{if(modelError)throw modelError;return {...t,id:t.modelId,api:"mock",maxTokens:1000};},
    sanitizeContext:(ctx:unknown)=>ctx,applyCopilotEndpoint:(m:unknown)=>m,
    applyCacheOptimizerHints:(context:unknown,options:unknown)=>({context,options}),
    streamSimple:(model:any)=>{const t={provider:model.provider,modelId:model.id,label:model.label};transportCalls.push(t);return transport(t);},
  };
  vm.createContext(sandbox);
  for (const name of ["isRetryableError","putOnCooldown","getHealthyTargets","tryTarget","tryTargetOnce","formatCircuitStatusSegment"]) {
    vm.runInContext(extract(name),sandbox);
  }
  return {
    cb,cooldowns,transportCalls,output,
    time:()=>now, advance:(ms:number)=>{now+=ms;},
    setTransport:(fn:typeof transport)=>{transport=fn;},
    events:(events:Event[])=>{transport=async function*(){yield* events;};},
    credentials:(value:boolean)=>{credentials=value;},
    modelError:(value?:Error)=>{modelError=value;},
    healthy:(route="a"):Target[]=>sandbox.getHealthyTargets(route),
    status:():string=>sandbox.formatCircuitStatusSegment(),
    attempt:(t:Target=bad,route="a",signal?:AbortSignal,onAttempt?:()=>void):Promise<any>=>sandbox.tryTarget(
      {push:(event:Event)=>output.push(event)}, {id:route,provider:"auto-router"}, t,
      {messages:[]}, {signal}, {requestId:"mock"}, onAttempt),
    key:getOperationalTargetKey, cooldownKey:getOperationalCooldownKey,
  };
}
