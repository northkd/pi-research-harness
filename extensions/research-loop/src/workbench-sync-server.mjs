import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { digest } from './workbench-sync.mjs';

const ENDPOINT='/api/res-workflow/workbench-sync';
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function validateDashboardOrigin(value){const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('fixed-loopback-dashboard-origin-required');return url.origin;}
async function boundedJson(url,headers,fetcher){const response=await fetcher(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(8000)});if(response.status!==200){const error=Error('upstream-refused');error.statusCode=[401,403,404].includes(response.status)?response.status:503;throw error;}if(!response.body)throw Error('upstream-body-missing');const reader=response.body.getReader(),parts=[];let bytes=0;try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>12*1024*1024)throw Error('upstream-response-too-large');parts.push(Buffer.from(next.value));}}catch(error){await reader.cancel().catch(()=>{});throw error;}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
/** Both reads use this request's credentials. Discovery credentials never enter this function. */
export async function authorizeWorkbenchCaller({origin,headers,cwd,fetcher=fetch}){
  const [snapshot,sessions]=await Promise.all([
    boundedJson(origin+'/api/res-workflow?cwd='+encodeURIComponent(cwd),headers,fetcher),
    boundedJson(origin+'/api/sessions',headers,fetcher),
  ]);
  const stateText=snapshot?.research?.['state.json'];
  if(snapshot?.adopted!==true||typeof snapshot.cwd!=='string'||snapshot.cwd!==cwd||typeof snapshot.adoption?.id!=='string'||typeof stateText!=='string'||sessions?.success!==true||!Array.isArray(sessions.data))throw Error('caller-scope-unavailable');
  const state=JSON.parse(stateText);if(!state?.charter||typeof state.charter.objective!=='string'||!Array.isArray(state.charter.successCriteria))throw Error('caller-charter-unavailable');
  return{binding:{cwd:snapshot.cwd,adoptionId:snapshot.adoption.id,charterHash:'sha256:'+digest(state.charter)},sessions:sessions.data};
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
      const headers={'x-forwarded-for':typeof request.headers['x-forwarded-for']==='string'?request.headers['x-forwarded-for']:'203.0.113.254','x-forwarded-proto':'https'};
      // A transport credential must not grant a remote caller local-operator privileges.
      if(localCaller==='1')headers['x-pi-local-token']=incoming;
      for(const key of ['cookie','authorization'])if(typeof request.headers[key]==='string')headers[key]=request.headers[key];
      const first=await authorizeWorkbenchCaller({origin,headers,cwd,fetcher});
      // A first intersection prevents speculative cache reads for a foreign principal.
      collector.readForCaller(first.binding,first.sessions);
      const final=await authorizeWorkbenchCaller({origin,headers,cwd,fetcher});
      if(JSON.stringify(first.binding)!==JSON.stringify(final.binding))return send(409,{error:'caller-scope-changed'});
      const observation=collector.readForCaller(final.binding,final.sessions);
      if(Buffer.byteLength(JSON.stringify(observation))>512*1024)throw Error('projection-too-large');
      send(200,observation);
    }catch(error){send(error.statusCode??503,{error:'workbench-sync-unavailable'});}
    finally{if(counted)inFlight--;}
  });
}
