import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { digest } from './workbench-sync.mjs';

const ENDPOINT='/api/res-workflow/workbench-sync';
const MAX_OBSERVATION_BYTES=512*1024;
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function validateDashboardOrigin(value){const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('fixed-loopback-dashboard-origin-required');return url.origin;}
async function boundedJson(url,headers,fetcher){const response=await fetcher(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(8000)});if(response.status!==200){const error=Error('upstream-refused');error.statusCode=[401,403,404].includes(response.status)?response.status:503;throw error;}if(!response.body)throw Error('upstream-body-missing');const reader=response.body.getReader(),parts=[];let bytes=0;try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>12*1024*1024)throw Error('upstream-response-too-large');parts.push(Buffer.from(next.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
/** Both reads use this request's credentials. Discovery credentials never enter this function. */
export async function authorizeWorkbenchCaller({origin,headers,cwd,fetcher=fetch}){
  const archiveQuery=new URLSearchParams({cwd,limit:'200'});
  const [snapshot,sessions,archive]=await Promise.all([
    boundedJson(origin+'/api/res-workflow?cwd='+encodeURIComponent(cwd),headers,fetcher),
    boundedJson(origin+'/api/sessions',headers,fetcher),
    boundedJson(origin+'/api/sessions/archived?'+archiveQuery,headers,fetcher),
  ]);
  const stateText=snapshot?.research?.['state.json'];
  if(snapshot?.adopted!==true||typeof snapshot.cwd!=='string'||snapshot.cwd!==cwd||typeof snapshot.adoption?.id!=='string'||typeof stateText!=='string'||sessions?.success!==true||!Array.isArray(sessions.data)||archive?.success!==true||!Array.isArray(archive.data?.items))throw Error('caller-scope-unavailable');
  const state=JSON.parse(stateText);if(!state?.charter||typeof state.charter.objective!=='string'||!Array.isArray(state.charter.successCriteria))throw Error('caller-charter-unavailable');
  const visible=new Map([...archive.data.items,...sessions.data].map(row=>[row.id,row]));
  return{binding:{cwd:snapshot.cwd,adoptionId:snapshot.adoption.id,charterHash:'sha256:'+digest(state.charter)},sessions:[...visible.values()],archivePartial:typeof archive.data.nextCursor==='string'};
}

function boundObservation(observation,archivePartial){
  const oversized=Buffer.byteLength(JSON.stringify(observation))>MAX_OBSERVATION_BYTES;
  if(!oversized&&!archivePartial)return observation;
  const {revision,updatedAt,heartbeatAt,...content}=observation;
  const reasons=[...new Set([
    ...(archivePartial?['archived-session-page-capacity']:[]),
    ...(oversized?['execution-text-capacity']:[]),
    ...content.coverage.reasons,
  ])].slice(0,32);
  const coverage={...content.coverage,partial:true,reasons};
  for(const limit of oversized?[1024,384,0]:[Infinity]){
    const executions=content.executions.map(execution=>{
      const row={...execution};
      for(const key of ['prompt','output','error']){
        if(typeof row[key]!=='string'||row[key].length<=limit)continue;
        if(limit===0)delete row[key];
        else row[key]=row[key].slice(0,limit-1)+'…';
      }
      return row;
    });
    const projection={...content,coverage,executions};
    const result={...projection,revision:'sha256:'+digest(projection),updatedAt,heartbeatAt};
    if(Buffer.byteLength(JSON.stringify(result))<=MAX_OBSERVATION_BYTES)return result;
  }
  throw Error('projection-too-large');
}
export function createWorkbenchSyncServer({collector,dashboardOrigin,proxyToken,fetcher=fetch}){
  const origin=validateDashboardOrigin(dashboardOrigin);if(typeof proxyToken!=='string'||proxyToken.length<16||proxyToken.length>8192)throw Error('proxy-token-invalid');let inFlight=0;
  return http.createServer({maxHeaderSize:24*1024},async(request,response)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json; charset=utf-8');
    const send=(status,body)=>{if(!response.destroyed){response.statusCode=status;response.end(JSON.stringify(body));}};
    let counted=false;
    try{
      if(request.method!=='GET')return send(405,{error:'method-not-allowed'});
      const url=new URL(request.url,'http://127.0.0.1');if(url.pathname!==ENDPOINT)return send(404,{error:'not-found'});
      const incoming=request.headers['x-pi-local-token'];if(!equal(incoming,proxyToken))return send(401,{error:'caller-credential-required'});
      // DPoP proofs bind an individual URL; never strip one and downgrade authentication.
      if(request.headers.dpop)return send(403,{error:'caller-proof-forwarding-unsupported'});
      const localCaller=request.headers['x-pi-caller-local'];if(localCaller!=='0'&&localCaller!=='1')return send(400,{error:'caller-classification-required'});
      if([...url.searchParams.keys()].some(k=>k!=='cwd')||url.searchParams.getAll('cwd').length!==1)return send(400,{error:'only-cwd-query-allowed'});
      const cwd=url.searchParams.get('cwd');if(!cwd?.startsWith('/')||cwd.length>4096||cwd.includes('\0'))return send(400,{error:'absolute-cwd-required'});
      if(inFlight>=8)return send(503,{error:'collector-busy'});inFlight++;counted=true;
      // Only the Dashboard can classify a request using the private transport credential.
      const headers=localCaller==='1'
        ? {'x-pi-local-token':incoming}
        : {'x-forwarded-for':typeof request.headers['x-forwarded-for']==='string'?request.headers['x-forwarded-for']:'203.0.113.254','x-forwarded-proto':'https'};
      for(const key of ['cookie','authorization'])if(typeof request.headers[key]==='string')headers[key]=request.headers[key];
      const first=await authorizeWorkbenchCaller({origin,headers,cwd,fetcher});
      // A first intersection prevents speculative cache reads for a foreign principal.
      collector.readForCaller(first.binding,first.sessions);
      const final=await authorizeWorkbenchCaller({origin,headers,cwd,fetcher});
      if(JSON.stringify(first.binding)!==JSON.stringify(final.binding))return send(409,{error:'caller-scope-changed'});
      const observation=collector.readForCaller(final.binding,final.sessions);
      send(200,boundObservation(observation,final.archivePartial));
    }catch(error){send(error.statusCode??503,{error:'workbench-sync-unavailable'});}
    finally{if(counted)inFlight--;}
  });
}
