import { randomUUID } from 'node:crypto';

const MARK = Symbol.for('pi-research-budget-runtime.v1');
const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
const STREAM_METHODS = new Set(['stream', 'streamSimple']);
const UNSUPPORTED_METHODS = new Set(['streamDeferred', 'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify']);
function fail(code) { throw new Error(code); }
function sameScope(one, two) {
  return one?.schema === 'pi-research-budget-scope.v1' && ['cwd', 'charterHash', 'scopeId', 'parentSessionId'].every(key => one[key] === two?.[key]);
}
export function isResearchBudgetRuntime(value, descriptor) {
  // Pi 1.3's compatibility ModelRegistry retains its ModelRuntime in `runtime`.
  return sameScope(value?.[MARK] ?? value?.runtime?.[MARK], descriptor);
}
function checkSignal(signal) { if (signal?.aborted) fail('research-budget-aborted'); }
function requestSignal(one,two) { return one && two && one !== two ? AbortSignal.any([one,two]) : one ?? two; }
function assertReady(store, descriptor, signal) {
  checkSignal(signal);
  const scope = store.readResearchBudgetScope(descriptor);
  if (scope.scopeId !== descriptor.scopeId || scope.parentSessionId !== descriptor.parentSessionId) fail('research-budget-scope-mismatch');
  const snapshot = store.readResearchBudget(descriptor);
  checkSignal(signal);
  return snapshot;
}
function guardedResponse(response, settle, signal) {
  if (!response.body) { if (!response.ok) settle('failed'); return response; }
  const reader=response.body.getReader();let ended=false;
  const finish=(outcome)=>{if(ended)return;ended=true;signal?.removeEventListener('abort',abort);settle(outcome);};
  const abort=()=>{finish('unknown');void reader.cancel().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const body=new ReadableStream({
    async pull(controller){try{const next=await reader.read();if(next.done){if(!response.ok)finish('failed');else signal?.removeEventListener('abort',abort);controller.close();}else controller.enqueue(next.value);}catch{finish('unknown');controller.error(new Error('research-budget-stream-unknown'));}},
    async cancel(){finish('unknown');await reader.cancel();},
  });
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}

/** Scope-bound usage accounting only; the original shared runtime is never changed. */
export async function bindResearchBudgetRuntime(runtime, descriptor, options={}) {
  if (!sameScope(descriptor, descriptor) || typeof descriptor.cwd !== 'string' || typeof descriptor.scopeId !== 'string' || typeof descriptor.parentSessionId !== 'string') fail('research-budget-scope-mismatch');
  const store=options.store ?? await import('./research-budget.mjs');
  assertReady(store,descriptor,options.signal);
  const marker=Object.freeze({...descriptor});
  const wrappers=new Map();
  let proxy;
  proxy=new Proxy(runtime,{
    get(target,property){
      if(property===MARK)return marker;
      if(property==='complete'||property==='completeSimple')return(model,context,requestOptions)=>proxy[property==='complete'?'stream':'streamSimple'](model,context,requestOptions).result();
      if(UNSUPPORTED_METHODS.has(property))return()=>fail('research-budget-transport-unsupported');
      if(STREAM_METHODS.has(property)){
        if(!wrappers.has(property))wrappers.set(property,(model,context,requestOptions={})=>{
          const signal=requestSignal(requestOptions.signal,options.signal);
          assertReady(store,descriptor,signal);
          if(!APIS.has(model?.api))fail('research-budget-transport-unsupported');
          if((target.getRegisteredNativeProvider?.(model.provider) ?? target.runtime?.getRegisteredNativeProvider?.(model.provider)) || (target.getRegisteredProviderConfig?.(model.provider) ?? target.runtime?.getRegisteredProviderConfig?.(model.provider))?.streamSimple)fail('research-budget-transport-unsupported');
          const originalFetch=requestOptions.fetch ?? globalThis.fetch;
          const pending=[];
          const fetch=async(input,init={})=>{
            const transportSignal=requestSignal(signal,init.signal ?? (input instanceof Request ? input.signal : undefined));
            assertReady(store,descriptor,transportSignal);
            const reservation=store.reserveResearchBudget({...descriptor,requestId:'model-'+randomUUID(),kind:'model-request',metadata:{model:{provider:model.provider,id:model.id},...(options.phase?{phase:options.phase}:{}),...(options.role?{role:options.role}:{})}});
            if(reservation.reused)fail('research-budget-result-unknown-no-replay');
            let settled=false;
            const settle=(outcome)=>{if(settled)return;settled=true;store.settleResearchBudget({...descriptor,reservationId:reservation.reservationId,outcome});};
            pending.push(settle);
            try{
              assertReady(store,descriptor,transportSignal);
              const response=await originalFetch(input,{...init,signal:transportSignal,redirect:'error'});
              return guardedResponse(response,settle,transportSignal);
            }catch(error){settle('unknown');throw error;}
          };
          // Fetch is called for each SDK transport retry; it is never an extension event hook.
          const stream=Reflect.apply(target[property],target,[model,context,{...requestOptions,signal,transport:'sse',fetch}]);
          const terminal=message=>{const outcome=['stop','length','toolUse'].includes(message?.stopReason)?'completed':'unknown';for(const settle of pending)settle(outcome);};
          return new Proxy(stream,{get(source,key){
            if(key==='result')return()=>source.result().then(message=>{terminal(message);return message;},error=>{terminal();throw error;});
            if(key===Symbol.asyncIterator)return()=>{
              const iterator=source[Symbol.asyncIterator]();let observed=false;
              return {async next(){try{const next=await iterator.next();if(next.value?.type==='done'){observed=true;terminal(next.value.message);}else if(next.value?.type==='error'){observed=true;terminal();}else if(next.done&&!observed)terminal();return next;}catch(error){terminal();throw error;}},async return(){terminal();return iterator.return?iterator.return():{done:true};},[Symbol.asyncIterator](){return this;}};
            };
            const value=Reflect.get(source,key,source);return typeof value==='function'?value.bind(source):value;
          }});
        });
        return wrappers.get(property);
      }
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return proxy;
}
