import { knowledgeOperation, knowledgeOperationDeadline, KNOWLEDGE_OPERATION_LIMITS } from './knowledge-operation';
import { runOptionalDiagnostic } from '../ai/business-information-timing';
import { telegramPreflightFailed, type ProviderRejection, type TelegramPreflightMethod, type TelegramPreflightRead } from './knowledge-preflight-diagnostic';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import type { DeliveryOutcome, KnowledgeTask, KnowledgeScope } from './knowledge-lifecycle';
import { NativeKnowledgeBindings, validNativeRecipient } from './native-knowledge-binding';

const VERSION='v25.0'; // Match existing native send helpers, not a provider-version migration.
const messageId=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9:_.=+/-]{1,256}$/u.test(v);
const unsent=(retryable=false,retryAfterMs?:number):DeliveryOutcome=>({kind:'DEFINITIVELY_UNSENT',retryable,...(retryAfterMs!==undefined?{retryAfterMs}:{})});
const ambiguous=():DeliveryOutcome=>({kind:'AMBIGUOUS'});
async function jsonRead(fetcher:typeof fetch,url:URL,token:string,signal:AbortSignal,read?:TelegramPreflightRead):Promise<any|null>{
  if(signal.aborted)throw new Error('knowledge_operation_stopped');
  const response=await fetcher(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`},signal});
  if (read) read.httpStatus = response.status;
  if (!response.ok) {
    if (read) read.failure = 'provider_rejection';
    return null;
  }
  const data = await response.json().catch(error => {
    if (read) read.bodyError = error;
    return null;
  });
  if (read && (data?.error || data?.ok === false)) read.failure = 'provider_rejection';
  return data?.error ? null : data;
}
const telegramId = (id: unknown) => typeof id === 'string' || typeof id === 'number';
/** Fresh, read-only provider capability checks. No AI call or send. Unknown
 * response shapes/unsupported account products fail closed. No permission cache.
 */
export async function nativeProviderEligible(bindings:NativeKnowledgeBindings,task:KnowledgeTask,fetcher:typeof fetch=fetch,
  signal:AbortSignal=AbortSignal.timeout(5000), expected?:ResolvedChannelConnection, rejected?:(reason:ProviderRejection)=>unknown,
  diagnoseTelegram = false):Promise<boolean>{
  const callerSignal=signal;
  const startedAt = Date.now();
  let deadlineAt = startedAt + KNOWLEDGE_OPERATION_LIMITS.eligibilityMs;
  let telegramRead: TelegramPreflightRead | undefined;
  try { return await knowledgeOperation(async boundedSignal=>{
  signal=boundedSignal;
  deadlineAt = knowledgeOperationDeadline() ?? deadlineAt;
  const reject=(reason:ProviderRejection):false=>{runOptionalDiagnostic(()=>rejected?.(reason));return false;};
  const resolved=await bindings.resolve(task.scope);if(!resolved)return reject('BINDING_OR_CONNECTION');
  const {binding:b,connection:c}=resolved;
  if(expected && (expected.id!==c.id || expected.credential.accessToken!==c.credential.accessToken || expected.providerAccountId!==c.providerAccountId))return reject('CONNECTION_CHANGED');
  const token=c.credential.accessToken;
  const eventAt=await bindings.eventTime(task);if(eventAt===null || eventAt>Date.now())return reject('EVENT_TIME');
  if(b.channel==='telegram'){
    // Ordinary private bot conversations only; business connections/groups need
    // their own rights/identity contract and are not silently treated as bots.
    if(c.providerConnectionId)return reject('TELEGRAM_CONNECTION_MODE');
    const api=(method:string,params:Record<string,string>={})=>{const u=new URL(`https://api.telegram.org/bot${token}/${method}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u;};
    const check = async (method: TelegramPreflightMethod, reason: ProviderRejection, params: Record<string, string>,
      eligible: (data: any) => boolean, wellFormed: (result: any) => boolean) => {
      const read: TelegramPreflightRead | undefined = diagnoseTelegram ? { method } : undefined;
      telegramRead = read;
      const data = await jsonRead(fetcher, api(method, params), token, signal, read);
      const allowed = eligible(data);
      // Leave the in-flight method available to the outer deadline race.
      if (read && !signal.aborted && Date.now() < deadlineAt) {
        if (!allowed) runOptionalDiagnostic(() => telegramPreflightFailed(task.turnId, read, startedAt, deadlineAt,
          read.failure ?? (data?.ok === true && wellFormed(data.result) ? 'eligibility_denial' : 'malformed_response'), read.bodyError));
        telegramRead = undefined;
      }
      return allowed || reject(reason);
    };
    if (!await check('getMe', 'TELEGRAM_BOT_IDENTITY', {},
      me => me?.ok === true && String(me.result?.id) === b.account && me.result?.is_bot === true,
      result => telegramId(result?.id) && typeof result?.is_bot === 'boolean')) return false;
    if (!await check('getChat', 'TELEGRAM_PRIVATE_CHAT', { chat_id: b.recipient },
      chat => chat?.ok === true && String(chat.result?.id) === b.recipient && chat.result?.type === 'private',
      result => telegramId(result?.id) && typeof result?.type === 'string')) return false;
    return await check('getChatMember', 'TELEGRAM_MEMBERSHIP', { chat_id: b.recipient, user_id: b.account },
      member => member?.ok === true && String(member.result?.user?.id) === b.account && ['member', 'administrator', 'creator'].includes(member.result?.status),
      result => telegramId(result?.user?.id) && typeof result?.status === 'string');
  }
  if(Date.now()-eventAt>=86400000)return reject('RESPONSE_WINDOW'); // Only standard customer-response windows; no tags/templates/extensions.
  const host=b.channel==='instagram'?'graph.instagram.com':'graph.facebook.com';
  const url=(path:string,params:Record<string,string>={})=>{const u=new URL(`https://${host}/${VERSION}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);return u;};
  if(b.channel==='whatsapp'){
    const id=(v:unknown):v is string=>typeof v==='string' && /^[1-9][0-9]{0,31}$/u.test(v);
    const sameConnection=(other:ResolvedChannelConnection)=>other.businessId===c.businessId && other.provider===c.provider && other.id===c.id &&
      other.providerAccountId===c.providerAccountId && other.providerConnectionId===c.providerConnectionId &&
      other.credential.accessToken===token && other.status===c.status && other.reconnectRequired===c.reconnectRequired &&
      other.tokenExpiresAt===c.tokenExpiresAt && JSON.stringify(other.grantedScopes)===JSON.stringify(c.grantedScopes);
    if(expected && !sameConnection(expected))return reject('CONNECTION_CHANGED');
    if(!id(c.providerConnectionId) || !id(b.account) || !c.grantedScopes.includes('whatsapp_business_messaging'))return reject('WHATSAPP_CONNECTION_OR_SCOPE');
    // Trusted server configuration only; never infer an allowed app from a token.
    // No fallback to the shared OAuth/webhook app identity.
    const expectedApp=process.env.META_WHATSAPP_APP_ID||'';
    if(!/^[1-9][0-9]{0,31}$/u.test(expectedApp))return reject('WHATSAPP_APP_CONFIGURATION');
    const debug=await jsonRead(fetcher,url('debug_token',{input_token:token}),token,signal);const d=debug?.data;
    if(d?.app_id!==expectedApp)return reject('WHATSAPP_TOKEN_APP');
    if(d?.is_valid!==true)return reject('WHATSAPP_TOKEN_VALIDITY');
    if(!Array.isArray(d.scopes) || d.scopes.some((s:unknown)=>typeof s!=='string') ||
      !['whatsapp_business_messaging','whatsapp_business_management'].every(s=>d.scopes.includes(s)))return reject('WHATSAPP_TOKEN_SCOPE');
    const unexpired=()=>['expires_at','data_access_expires_at'].every(k=>Number.isSafeInteger(d[k]) && d[k]>=0 && (d[k]===0 || d[k]*1000>Date.now()));
    if(!unexpired())return reject('WHATSAPP_TOKEN_EXPIRY');
    // Omitted targets are not a grant. Explicit exclusions/malformed entries
    // fail; live asset/assignment evidence below is required on every check.
    if(d.granular_scopes!==undefined && (!Array.isArray(d.granular_scopes) || d.granular_scopes.some((g:any)=>
      !g || typeof g!=='object' || Array.isArray(g) || typeof g.scope!=='string' ||
      ['whatsapp_business_messaging','whatsapp_business_management'].includes(g.scope) && Object.prototype.hasOwnProperty.call(g,'target_ids') &&
      (!Array.isArray(g.target_ids) || g.target_ids.some((v:unknown)=>!id(v)) || !g.target_ids.includes(c.providerConnectionId)))))return reject('WHATSAPP_GRANULAR_SCOPE');
    if(!id(d.user_id))return reject('WHATSAPP_WABA_ASSIGNMENT');
    // Same read contracts and conservative MANAGE policy as onboarding; avoid
    // its unrelated provisioning work and never trust a diagnostic snapshot.
    const waba=await jsonRead(fetcher,url(c.providerConnectionId,{fields:'id,owner_business_info'}),token,signal);
    if(waba?.id!==c.providerConnectionId || !id(waba.owner_business_info?.id))return reject('WHATSAPP_WABA_IDENTITY');
    const users=await jsonRead(fetcher,url(`${c.providerConnectionId}/assigned_users`,{business:waba.owner_business_info.id,fields:'id,tasks',limit:'100'}),token,signal);
    if(!Array.isArray(users?.data) || users.paging?.next || users.data.some((u:any)=>!id(u?.id)))return reject('WHATSAPP_WABA_ASSIGNMENT');
    const assignments=users.data.filter((u:any)=>u.id===d.user_id);
    if(assignments.length!==1 || !Array.isArray(assignments[0].tasks) || assignments[0].tasks.some((t:unknown)=>typeof t!=='string') ||
      !assignments[0].tasks.includes('MANAGE'))return reject('WHATSAPP_WABA_ASSIGNMENT');
    const phones=await jsonRead(fetcher,url(`${encodeURIComponent(c.providerConnectionId)}/phone_numbers`,{fields:'id',limit:'100'}),token,signal);
    if(!Array.isArray(phones?.data) || phones.paging?.next || phones.data.some((p:any)=>!id(p?.id)) || phones.data.filter((p:any)=>p.id===b.account).length!==1)return reject('WHATSAPP_PHONE_MEMBERSHIP');
    const phone=await jsonRead(fetcher,url(b.account,{fields:'id,health_status'}),token,signal);
    if(phone?.id!==b.account || phone.health_status?.can_send_message!=='AVAILABLE' || Date.now()-eventAt>=86400000)return reject('WHATSAPP_PHONE_HEALTH_OR_WINDOW');
    const current=await bindings.resolve(task.scope);
    if(!current || !sameConnection(current.connection) || current.binding.recipient!==b.recipient)return reject('CONNECTION_CHANGED');
    if(!unexpired())return reject('WHATSAPP_TOKEN_EXPIRY');
    return !signal.aborted && Date.now()-eventAt<86400000 || reject('WHATSAPP_PHONE_HEALTH_OR_WINDOW');
  }
  const required=b.channel==='instagram'?'instagram_business_manage_messages':'pages_messaging';
  if(!c.grantedScopes.includes(required))return reject('META_SAVED_SCOPE');
  const rawIdentity=await jsonRead(fetcher,url('me',{fields:b.channel==='instagram'?'user_id':'id'}),token,signal);
  const identity=Array.isArray(rawIdentity?.data)?rawIdentity.data[0]:rawIdentity;
  if((b.channel==='instagram'?(identity?.user_id||identity?.id):identity?.id)!==b.account)return reject('META_IDENTITY');
  // Reading conversations requires current messaging access, rather than only
  // trusting the scopes saved during onboarding. Read participant IDs only.
  const conversations=await jsonRead(fetcher,url(`${b.account}/conversations`,{platform:b.channel==='instagram'?'instagram':'messenger',
    user_id:b.recipient,fields:b.channel==='messenger'?'participants,can_reply':'participants',limit:'20'}),token,signal);
  return Array.isArray(conversations?.data) && conversations.data.some((c:any)=>{
    const ids=c.participants?.data?.map((p:any)=>p.id);
    return Array.isArray(ids) && ids.includes(b.recipient) && ids.includes(b.account) && (b.channel!=='messenger' || c.can_reply===true);
  }) && Date.now()-eventAt<86400000 || reject('META_CONVERSATION_OR_WINDOW');
  },{signal,timeoutMs:KNOWLEDGE_OPERATION_LIMITS.eligibilityMs});
  } catch(error) {
    const stopped = callerSignal.aborted || (error as Error)?.message === 'knowledge_operation_stopped';
    if (telegramRead) telegramPreflightFailed(task.turnId, telegramRead, startedAt, deadlineAt,
      stopped ? (Date.now() >= deadlineAt ? 'timeout' : 'cancelled') : 'unexpected_exception', error);
    if (stopped) return false;
    throw error;
  }
}

/** Exactly one raw provider POST; never call foreground boolean helpers. No
 * logging of URLs/tokens/recipients/body/errors. Network/parse/5xx ambiguity is
 * quarantined by the lifecycle; an HTTP 200 alone does not establish acceptance.
 */
export async function sendNativeKnowledge(c:ResolvedChannelConnection,recipient:string,text:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<DeliveryOutcome>{
  if(signal.aborted || !validNativeRecipient(c.provider,recipient) || !text.trim() || text.length>6000 || !c.credential.accessToken)return unsent();
  const token=c.credential.accessToken;let url:string;let body:any;
  if(c.provider==='telegram'){url=`https://api.telegram.org/bot${token}/sendMessage`;body={chat_id:recipient,text};}
  else if(c.provider==='whatsapp'){url=`https://graph.facebook.com/${VERSION}/${c.providerAccountId}/messages`;
    body={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'text',text:{preview_url:false,body:text}};}
  else {url=`https://${c.provider==='instagram'?'graph.instagram.com':'graph.facebook.com'}/${VERSION}/${c.provider==='instagram'?'me':c.providerAccountId}/messages`;
    body={recipient:{id:recipient},...(c.provider==='messenger'?{messaging_type:'RESPONSE'}:{}),message:{text}};}
  try{
    return await knowledgeOperation(async boundedSignal=>{
    const response=await fetcher(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:boundedSignal});
    const data:any=await response.json().catch(()=>null);
    if(response.ok && !data?.error){
      if(c.provider==='telegram' && data?.ok===true && Number.isSafeInteger(data.result?.message_id) && data.result.message_id>0 && String(data.result.chat?.id)===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:String(data.result.message_id)};
      if(c.provider==='whatsapp' && messageId(data?.messages?.[0]?.id) && /^wamid\./u.test(data.messages[0].id) && data.contacts?.[0]?.wa_id===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:data.messages[0].id};
      if(['instagram','messenger'].includes(c.provider) && messageId(data?.message_id) && data.recipient_id===recipient)
        return {kind:'API_ACCEPTED',providerMessageId:data.message_id};
    }
    const code=c.provider==='telegram'?data?.error_code:data?.error?.code;
    const retryHeader=response.headers.get('retry-after');
    const retrySeconds=retryHeader?(Number.isFinite(Number(retryHeader))?Number(retryHeader):(Date.parse(retryHeader)-Date.now())/1000):Number(data?.parameters?.retry_after);
    // Never shorten a provider-mandated wait to fit our retry cap. A longer
    // wait is a terminal unsent disposition within this bounded task budget.
    const retryAllowed=!(Number.isFinite(retrySeconds)&&retrySeconds>60);
    const retryAfterMs=retryAllowed&&Number.isFinite(retrySeconds)&&retrySeconds>0?Math.max(1000,Math.ceil(retrySeconds*1000)):undefined;
    if(response.status>=400 && response.status<500 && response.status!==408 && Number.isInteger(code))return unsent(response.status===429&&retryAllowed,response.status===429?retryAfterMs:undefined);
    if(c.provider==='telegram' && data?.ok===false && Number.isInteger(code) && code>=400 && code<500 && code!==408)return unsent(code===429&&retryAllowed,code===429?retryAfterMs:undefined);
    return ambiguous();
    },{signal,timeoutMs:KNOWLEDGE_OPERATION_LIMITS.sendMs,factualResult:true});
  }catch{return ambiguous();}
}
