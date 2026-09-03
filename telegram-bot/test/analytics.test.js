import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { captureSource, overviewData, periodStart, recordStart, resolveStart, showStats, sourceKeyValid, statsCallback, statsCommand, trackedPayload } from '../src/analytics.js';

function setup(historical=false) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  sql.exec("INSERT INTO guides(guide_key,title,document_file_id) VALUES('guide_team','Команда','pdf_team'),('guide_company_abroad','Компания','pdf_company'); INSERT INTO users(user_id) VALUES('1'),('2');");
  if (historical) {
    sql.exec("INSERT INTO activations(guide_key,user_id,activated_at) VALUES('guide_team','1','2026-09-01 14:00:00'); INSERT INTO deliveries(guide_key,user_id,status,delivered_at) VALUES('guide_team','1','sent','2026-09-01 14:01:00');");
    const payload=JSON.stringify({message:{chat:{type:'private'},from:{id:2},text:'/start',date:1788250000}});
    sql.prepare('INSERT INTO incoming_updates(update_id,payload_json) VALUES(?,?)').run('old',payload);
  }
  sql.exec(readFileSync(new URL('../migrations/0002_analytics.sql',import.meta.url),'utf8'));
  const db = {
    prepare(query) {
      let args=[];
      return {
        bind(...values) {args=values;return this;},
        async all() {return {results:sql.prepare(query).all(...args),success:true};},
        async first() {return sql.prepare(query).get(...args)||null;},
        async run() {const result=sql.prepare(query).run(...args);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
      };
    },
    async batch(statements) {sql.exec('BEGIN'); try {const out=[];for(const stmt of statements)out.push(await stmt.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}
  };
  return {sql,env:{DB:db,BOT_TOKEN:'test-only',TELEGRAM_WEBHOOK_SECRET:'test-secret',BOT_USERNAME:'zapasnoy_aerodrom_bot',OWNER_USER_IDS:'1',CHANNEL_ID:'-10010',CHANNEL_INVITE_URL:'https://t.me/test'},config:{owners:new Set(['1']),botUsername:'zapasnoy_aerodrom_bot',statsChatId:'-10099',statsTopicId:'5'}};
}
function message(id=10,user=1,text='/start guide_team') {return {message_id:id,chat:{id:user,type:'private'},from:{id:user,first_name:'Test'},date:1788436800,text};}
function mockTelegram(t) {
  const sent=[];let subscribed=true;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=String(url).split('/').pop(),payload=JSON.parse(options.body);
    sent.push({method,payload});
    const result=method==='getChatMember'?{status:subscribed?'member':'left'}:{message_id:sent.length,chat:{id:payload.chat_id}};
    return Response.json({ok:true,result});
  });
  return {sent,setSubscribed(v){subscribed=v;}};
}
async function webhook(env,update) {
  const work=[];
  const r=await worker.fetch(new Request('https://example.test/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify(update)}),env,{waitUntil(p){work.push(p);}});
  await Promise.all(work);
  assert.equal(r.status,200);
}
test('migration preserves history, recovers guide-less starts, is rerunnable',()=>{
  const {sql}=setup(true);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM bot_starts').get().n,2);
  assert.equal(sql.prepare('SELECT source_key FROM guide_attribution').get().source_key,'unknown_history');
  sql.exec(readFileSync(new URL('../migrations/0002_analytics.sql',import.meta.url),'utf8'));
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,1);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM bot_starts').get().n,2);
  sql.close();
});
test('period boundaries use Moscow midnight and include today in 7/30 days',()=>{
  const now=new Date('2026-09-03T21:15:00Z');
  assert.equal(periodStart('t',now),'2026-09-03 21:00:00');
  assert.equal(periodStart('w',now),'2026-08-28 21:00:00');
  assert.equal(periodStart('m',now),'2026-08-05 21:00:00');
});
test('deep links support legacy keys, validated sources and Telegram size limit',async()=>{
  const {env}=setup();
  assert.equal(trackedPayload('g'.repeat(32),'s'.repeat(24)).length,60);
  assert.throws(()=>trackedPayload('bad guide','channel'));
  assert.equal(sourceKeyValid('unknown_history'),false);
  assert.deepEqual(await resolveStart(env,'guide_team'),{guideKey:'guide_team',sourceKey:'untagged'});
  assert.deepEqual(await resolveStart(env,'guide_team--s-landing_team'),{guideKey:'guide_team',sourceKey:'landing_team'});
  assert.deepEqual(await resolveStart(env,'guide_team--s-hacker'),{guideKey:'guide_team',sourceKey:'untagged'});
});
test('first-touch attribution and unique bot starts survive repeated events',async()=>{
  const {env,sql}=setup();
  const msg=message();
  await recordStart(env,msg,{guideKey:'guide_team',sourceKey:'landing_team'});
  await recordStart(env,msg,{guideKey:'guide_team',sourceKey:'landing_team'});
  await recordStart(env,message(11),{guideKey:'guide_team',sourceKey:'channel'});
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM bot_start_events').get().n,2);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM bot_starts').get().n,1);
  assert.equal(sql.prepare('SELECT source_key FROM guide_attribution').get().source_key,'landing_team');
});
test('live webhook path: unsubscribed -> check -> PDF, source preserved, no duplicate count',async(t)=>{
  const {env,sql}=setup();const tg=mockTelegram(t);tg.setSubscribed(false);
  const update={update_id:100,message:message(10,2,'/start guide_team--s-landing_team')};
  await webhook(env,update);
  assert.equal(tg.sent.filter(x=>x.method==='sendDocument').length,0);
  assert.ok(tg.sent.some(x=>x.payload.reply_markup?.inline_keyboard.some(row=>row.some(b=>b.callback_data==='check:guide_team'))));
  tg.setSubscribed(true);
  await webhook(env,{update_id:101,callback_query:{id:'check',from:{id:2},message:message(22,2),data:'check:guide_team'}});
  await webhook(env,update);
  await webhook(env,{update_id:102,message:message(11,2,'/start guide_team--s-channel')});
  assert.equal(tg.sent.filter(x=>x.method==='sendDocument').length,1);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='sent'").get().n,1);
  assert.equal(sql.prepare('SELECT source_key FROM guide_attribution').get().source_key,'landing_team');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM incoming_updates WHERE status!='done'").get().n,0);
});
test('owner menu is private, not counted as activation, denies nonowners and foreign bot commands',async(t)=>{
  const {env,sql}=setup();const tg=mockTelegram(t);
  await webhook(env,{update_id:200,message:message(20,1,'/start stats')});
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM bot_starts').get().n,0);
  assert.ok(tg.sent.some(x=>x.payload.text?.startsWith('📊 Статистика')));
  const before=tg.sent.length;
  await webhook(env,{update_id:201,message:message(21,2,'/stats@another_bot')});
  assert.equal(tg.sent.length,before);
  await webhook(env,{update_id:202,message:message(22,2,'/stats')});
  assert.match(tg.sent.at(-1).payload.text,/только владельцам/);
});
test('group launcher contains no figures; callback sends full report only to owner DM',async(t)=>{
  const {env,config}=setup();const tg=mockTelegram(t);
  const group={...message(),chat:{id:-10099,type:'supergroup'},message_thread_id:5};
  await statsCommand(env,config,group);
  assert.equal(tg.sent.at(-1).payload.chat_id,-10099);
  assert.doesNotMatch(tg.sent.at(-1).payload.text,/Новых активаций/);
  await statsCallback(env,config,{id:'one',from:{id:1},message:group,data:'st:private:a'});
  assert.equal(tg.sent.at(-1).payload.chat_id,1);
  assert.match(tg.sent.at(-1).payload.text,/Новых активаций/);
  await statsCallback(env,config,{id:'two',from:{id:2},message:group,data:'st:sources:a:0'});
  assert.equal(tg.sent.at(-1).method,'answerCallbackQuery');
  await statsCallback(env,config,{id:'three',from:{id:1},message:{...group,message_thread_id:77},data:'st:overview:a'});
  assert.equal(tg.sent.at(-1).payload.show_alert,true);
});
test('all views render within Telegram limits, pagination and source creation work',async(t)=>{
  const {env,config,sql}=setup(true);const tg=mockTelegram(t);
  for(const data of ['st:overview:a','st:guides:a:0','st:sources:a:0','st:guide:a:0:guide_team','st:links:a:0','st:linkguide:a:0:guide_team','st:addsource']) {
    await showStats(env,config,1,data);
    const p=tg.sent.at(-1).payload;
    assert.ok(p.text.length<4096);
    for(const row of p.reply_markup.inline_keyboard)for(const b of row)assert.ok(Buffer.byteLength(b.callback_data||'')<=64);
  }
  await captureSource(env,config,message(42,1,'yandex_team | Яндекс: команда'));
  assert.equal(sql.prepare("SELECT title FROM traffic_sources WHERE source_key='yandex_team'").get().title,'Яндекс: команда');
  await showStats(env,config,1,'st:sources:a:0');
  assert.ok(tg.sent.at(-1).payload.reply_markup.inline_keyboard.flat().some(b=>b.text==='Далее →'));
  const d=await overviewData(env,'1970-01-01 00:00:00');
  assert.equal(d.starts,2);assert.equal(d.deliveries,1);
});
