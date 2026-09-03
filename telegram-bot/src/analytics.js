import { dbAll, dbBatch, dbFirst, dbRun } from './db.js';
import { telegram } from './telegram.js';
import { isGuideKey, keyboard } from './utils.js';

const PERIODS = { a: 'Всё время', t: 'Сегодня', w: '7 дней', m: '30 дней' };
const RESERVED = new Set(['unknown_history', 'untagged']);
const PAGE_SIZE = 5;
export function sourceKeyValid(key) { return /^[a-z][a-z0-9_]{0,23}$/.test(key) && !RESERVED.has(key); }
export function trackedPayload(guide, source) {
  const payload = `${guide}--s-${source}`;
  if (!isGuideKey(guide) || !sourceKeyValid(source) || payload.length > 64) throw new Error('Invalid tracking link');
  return payload;
}
export function periodStart(period, now = new Date()) {
  if (!PERIODS[period] || period === 'a') return '1970-01-01 00:00:00';
  const moscow = new Date(now.getTime() + 3 * 3600_000);
  moscow.setUTCHours(0, 0, 0, 0);
  const days = period === 'w' ? 6 : period === 'm' ? 29 : 0;
  return new Date(moscow.getTime() - days * 86400_000 - 3 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
export async function resolveStart(env, raw = '') {
  // Check the whole key first: older valid guide keys may contain the delimiter.
  const exact = isGuideKey(raw) ? await dbFirst(env, 'SELECT guide_key FROM guides WHERE guide_key=? AND active=1', [raw]) : null;
  if (exact) return { guideKey: raw, sourceKey: 'untagged' };
  const match = raw.length <= 64 && raw.match(/^(.+)--s-([a-z][a-z0-9_]{0,23})$/);
  if (match && isGuideKey(match[1])) {
    const source = await dbFirst(env, 'SELECT source_key FROM traffic_sources WHERE source_key=?', [match[2]]);
    const guide = await dbFirst(env, 'SELECT guide_key FROM guides WHERE guide_key=? AND active=1', [match[1]]);
    return { guideKey: guide?.guide_key || null, sourceKey: source && !RESERVED.has(source.source_key) ? source.source_key : 'untagged' };
  }
  return { guideKey: null, sourceKey: 'untagged' };
}
export async function recordStart(env, message, { guideKey, sourceKey }) {
  const userId = String(message.from.id);
  const eventKey = `${message.chat.id}:${message.message_id}`;
  const at = new Date((message.date || Math.floor(Date.now()/1000)) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO bot_start_events(event_key,user_id,guide_key,source_key,started_at) VALUES(?,?,?,?,?)').bind(eventKey,userId,guideKey,sourceKey,at),
    env.DB.prepare('INSERT OR IGNORE INTO bot_starts(user_id,source_key,first_started_at) VALUES(?,?,?)').bind(userId,sourceKey,at),
  ];
  if (guideKey) statements.push(env.DB.prepare('INSERT OR IGNORE INTO guide_attribution(guide_key,user_id,source_key,activated_at) VALUES(?,?,?,?)').bind(guideKey,userId,sourceKey,at));
  await dbBatch(env, statements);
}

export function isStatsLocation(config, message) {
  if (message?.chat?.type === 'private') return true;
  return Boolean(config.statsChatId && String(message?.chat?.id) === String(config.statsChatId)
    && (!config.statsTopicId || Number(message.message_thread_id) === Number(config.statsTopicId)));
}
function owner(config, userId) { return config.owners.has(String(userId)); }
function button(text, data) { return { text, callback_data: data }; }
function navigation(view, period, guide = '') {
  return [
    [button('📊 Обзор', `st:overview:${period}`), button('📚 Гайды', `st:guides:${period}:0`)],
    [button('🧭 Источники', `st:sources:${period}:0`), button('🔗 Ссылки', 'st:links:a:0')],
    Object.entries(PERIODS).map(([key,title]) => button(`${key===period?'✓ ':''}${title}`, `st:${view}:${key}:0${guide?':'+guide:''}`)),
  ];
}
function pagination(rows, view, period, page, total, guide = '') {
  const buttons = [];
  if (page > 0) buttons.push(button('← Назад', `st:${view}:${period}:${page-1}${guide?':'+guide:''}`));
  if ((page+1)*PAGE_SIZE < total) buttons.push(button('Далее →', `st:${view}:${period}:${page+1}${guide?':'+guide:''}`));
  if (buttons.length) rows.push(buttons);
}
async function deliverView(env, userId, text, rows, callback) {
  const payload = { chat_id:userId, text, reply_markup:keyboard(rows), link_preview_options:{is_disabled:true} };
  if (callback?.message?.chat?.type === 'private' && String(callback.message.chat.id) === String(userId)) {
    try { return await telegram(env,'editMessageText',{...payload,message_id:callback.message.message_id}); }
    catch (error) { if (/message is not modified/i.test(String(error))) return; throw error; }
  }
  return telegram(env,'sendMessage',payload);
}
export async function overviewData(env, since) {
  return dbFirst(env, `SELECT
    (SELECT COUNT(*) FROM bot_starts WHERE first_started_at>=?) starts,
    (SELECT COUNT(DISTINCT user_id) FROM bot_start_events WHERE started_at>=?) visitors,
    (SELECT COUNT(*) FROM bot_start_events WHERE started_at>=?) events,
    (SELECT COUNT(*) FROM activations WHERE activated_at>=?) activations,
    (SELECT COUNT(DISTINCT user_id) FROM deliveries WHERE status='sent' AND delivered_at>=?) recipients,
    (SELECT COUNT(*) FROM deliveries WHERE status='sent' AND delivered_at>=?) deliveries,
    (SELECT COUNT(*) FROM users WHERE active=1) reachable,
    (SELECT setting_value FROM settings WHERE setting_key='analytics_started_at') tracking_since`,
  Array(6).fill(since));
}
export async function showStats(env, config, userId, data='st:overview:a', callback=null) {
  if (!owner(config,userId)) return;
  const [,rawView,rawPeriod,rawPage,guide=''] = data.split(':');
  const view = rawView || 'overview';
  const period = PERIODS[rawPeriod] ? rawPeriod : 'a';
  const page = /^\d{1,6}$/.test(rawPage||'') ? Number(rawPage) : 0;
  const since = periodStart(period);
  const periodLabel = `${PERIODS[period]} · МСК`;
  let text = '';
  let rows = navigation(['guides','sources','guide'].includes(view)?view:'overview',period,guide);

  if (view === 'overview' || view === 'private') {
    const d = await overviewData(env,since);
    text = `📊 Статистика бота\n${periodLabel}\n\nНовых активаций бота: ${d.starts}\nУникальных получателей гайдов: ${d.recipients}\nВсего выдано гайдов: ${d.deliveries}\nАктиваций гайдов: ${d.activations}\n\nЗапусков /start с начала нового учёта: ${d.events}\nЛюдей с такими запусками: ${d.visitors}\nДоступны для сообщений сейчас: ${d.reachable}\n\nАктивация бота — первый /start человека. Один человек учитывается один раз; админ-меню не считается активацией.\nНовый учёт запусков и источников с ${d.tracking_since} UTC. История до этого восстановлена по сохранённым /start и активациям гайдов. Исторические повторы /start в новом счётчике не учтены.`;
  } else if (view === 'guides') {
    const total = await dbFirst(env,'SELECT COUNT(*) n FROM guides');
    const guides = await dbAll(env,`SELECT g.guide_key,g.title,
      (SELECT COUNT(*) FROM activations a WHERE a.guide_key=g.guide_key AND activated_at>=?) activations,
      (SELECT COUNT(*) FROM deliveries d WHERE d.guide_key=g.guide_key AND status='sent' AND delivered_at>=?) deliveries
      FROM guides g ORDER BY g.title LIMIT ? OFFSET ?`,[since,since,PAGE_SIZE,page*PAGE_SIZE]);
    text = `📚 Выдачи по гайдам\n${periodLabel}\n\n` + guides.results.map(g=>`${g.title.slice(0,180)}\nЗапросили: ${g.activations} · Получили: ${g.deliveries}`).join('\n\n') + '\n\nКаждый человек учитывается один раз на гайд. Запросы и выдачи фильтруются по своей дате; выдача может относиться к более раннему запросу.';
    for (const g of guides.results) rows.push([button(`🧭 ${g.title.slice(0,45)}`,`st:guide:${period}:0:${g.guide_key}`)]);
    pagination(rows,'guides',period,page,total.n);
  } else if (view === 'sources' || view === 'guide') {
    const guideKey = view==='guide' && isGuideKey(guide) ? guide : '';
    if (view==='guide' && !guideKey) return;
    const selected = guideKey ? await dbFirst(env,'SELECT title FROM guides WHERE guide_key=?',[guideKey]) : null;
    const total = await dbFirst(env,'SELECT COUNT(*) n FROM traffic_sources');
    const sources = await dbAll(env,`SELECT s.source_key,s.title,
      (SELECT COUNT(*) FROM bot_starts b WHERE b.source_key=s.source_key AND b.first_started_at>=?) starts,
      (SELECT COUNT(*) FROM activations a JOIN guide_attribution ga ON ga.guide_key=a.guide_key AND ga.user_id=a.user_id
        WHERE ga.source_key=s.source_key AND a.activated_at>=? AND (?='' OR a.guide_key=?)) activations,
      (SELECT COUNT(*) FROM deliveries d JOIN guide_attribution ga ON ga.guide_key=d.guide_key AND ga.user_id=d.user_id
        WHERE ga.source_key=s.source_key AND d.status='sent' AND d.delivered_at>=? AND (?='' OR d.guide_key=?)) deliveries,
      (SELECT COUNT(DISTINCT d.user_id) FROM deliveries d JOIN guide_attribution ga ON ga.guide_key=d.guide_key AND ga.user_id=d.user_id
        WHERE ga.source_key=s.source_key AND d.status='sent' AND d.delivered_at>=? AND (?='' OR d.guide_key=?)) recipients
      FROM traffic_sources s ORDER BY s.source_key LIMIT ? OFFSET ?`,
    [since,since,guideKey,guideKey,since,guideKey,guideKey,since,guideKey,guideKey,PAGE_SIZE,page*PAGE_SIZE]);
    text = `🧭 Источники${selected?' · '+selected.title.slice(0,150):''}\n${periodLabel}\n\n` + sources.results.map(s=>`${s.title}\n${guideKey?'':`Новых людей в боте: ${s.starts}\n`}Запросов гайдов: ${s.activations} · Выдач: ${s.deliveries}\nПолучателей: ${s.recipients}`).join('\n\n') + '\n\nИсточник человека — ссылка первого запуска бота. Источник выдачи — ссылка первого запроса этого гайда; повторные проверки подписки его не меняют. Получатель разных гайдов может встречаться в нескольких источниках.\n\nМетка показывает использованную ссылку, а не гарантированную площадку: ссылку могут переслать. Лендинг → общий пост канала не передаёт боту источник лендинга.';
    pagination(rows,view,period,page,total.n,guideKey);
  } else if (view === 'links') {
    const guides = await dbAll(env,'SELECT guide_key,title FROM guides WHERE active=1 ORDER BY title LIMIT ? OFFSET ?',[PAGE_SIZE,page*PAGE_SIZE]);
    const total = await dbFirst(env,'SELECT COUNT(*) n FROM guides WHERE active=1');
    text = '🔗 Ссылки с учётом источника\n\nВыберите гайд. Для каждой площадки используйте отдельную ссылку прямо на бота. Проверка подписки и выдача PDF сохраняются.\n\nОбычная ссылка на пост канала не сохраняет источник лендинга. Существующие лендинги автоматически не менялись.';
    rows = [[button('📊 Статистика','st:overview:a')]];
    for (const g of guides.results) rows.push([button(g.title.slice(0,55),`st:linkguide:a:0:${g.guide_key}`)]);
    rows.push([button('➕ Новый источник','st:addsource')]);
    pagination(rows,'links','a',page,total.n);
  } else if (view === 'linkguide') {
    if (!isGuideKey(guide)) return;
    const g = await dbFirst(env,'SELECT guide_key,title FROM guides WHERE guide_key=? AND active=1',[guide]);
    if (!g) return;
    const sources = await dbAll(env,"SELECT source_key,title FROM traffic_sources WHERE source_key NOT IN ('untagged','unknown_history') ORDER BY source_key LIMIT ? OFFSET ?",[PAGE_SIZE,page*PAGE_SIZE]);
    const total = await dbFirst(env,"SELECT COUNT(*) n FROM traffic_sources WHERE source_key NOT IN ('untagged','unknown_history')");
    text = `🔗 ${g.title}\n\n` + sources.results.map(s=>`${s.title}\nhttps://t.me/${config.botUsername}?start=${trackedPayload(guide,s.source_key)}`).join('\n\n') + '\n\nПоставьте нужную ссылку на соответствующую площадку. Источник записывается после нажатия Start, а не при просмотре ссылки.';
    rows = [[button('← Выбор гайда','st:links:a:0'),button('➕ Источник','st:addsource')]];
    pagination(rows,'linkguide','a',page,total.n,guide);
  } else if (view === 'addsource') {
    await dbRun(env,`INSERT INTO pending_actions(chat_id,user_id,action,expires_at) VALUES(?,?,'stats_source',datetime('now','+30 minutes'))
      ON CONFLICT(chat_id,user_id) DO UPDATE SET action='stats_source',payload_json=NULL,expires_at=datetime('now','+30 minutes')`,[String(userId),String(userId)]);
    text = 'Пришлите источник одной строкой:\nyandex_team | Яндекс: команда\n\nКлюч: латинская буква, затем буквы, цифры или _, до 24 символов. Название: до 60 символов. Для разных кампаний создавайте разные ключи. /cancel — отмена.';
    rows = [[button('← К ссылкам','st:links:a:0')]];
  } else return;
  return deliverView(env,userId,text,rows,callback);
}
export async function captureSource(env,config,message) {
  if (message.chat.type!=='private' || !owner(config,message.from?.id) || !message.text || message.text.startsWith('/')) return false;
  const pending = await dbFirst(env,"SELECT action FROM pending_actions WHERE chat_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP",[String(message.chat.id),String(message.from.id)]);
  if (pending?.action!=='stats_source') return false;
  const [key,...parts] = message.text.split('|');
  const source = key.trim();
  const title = parts.join('|').trim();
  if (!sourceKeyValid(source) || !title || title.length>60 || /[\r\n]/.test(title)) {
    await telegram(env,'sendMessage',{chat_id:message.chat.id,text:'Не сохранено. Нужны ключ и название: yandex_team | Яндекс: команда. Название — до 60 символов.'});
    return true;
  }
  const exists = await dbFirst(env,'SELECT title FROM traffic_sources WHERE source_key=?',[source]);
  if (exists) {
    await telegram(env,'sendMessage',{chat_id:message.chat.id,text:`Ключ ${source} уже существует: ${exists.title}. Выберите другой ключ или /cancel.`});
    return true;
  }
  await dbRun(env,'INSERT OR IGNORE INTO traffic_sources(source_key,title) VALUES(?,?)',[source,title]);
  await dbRun(env,'DELETE FROM pending_actions WHERE chat_id=? AND user_id=?',[String(message.chat.id),String(message.from.id)]);
  await showStats(env,config,message.from.id,'st:links:a:0');
  return true;
}
export async function statsCommand(env,config,message) {
  if (!owner(config,message.from?.id) || message.sender_chat || !isStatsLocation(config,message)) return;
  if (message.chat.type==='private') return showStats(env,config,message.from.id);
  return telegram(env,'sendMessage',{
    chat_id:message.chat.id, message_thread_id:message.message_thread_id,
    text:'📊 Меню статистики «Запасной аэродром»\n\nОбзор, выдачи гайдов и источники. Полный отчёт доступен только владельцам и открывается в личном чате бота.',
    reply_markup:keyboard([[button('📊 Открыть мою статистику','st:private:a')]]),
  });
}
export async function statsCallback(env,config,callback) {
  if (!owner(config,callback.from?.id) || callback.from?.is_bot || !isStatsLocation(config,callback.message)) {
    await telegram(env,'answerCallbackQuery',{callback_query_id:callback.id,text:'Статистика доступна только владельцам в личном чате или в меню статистики.',show_alert:true}).catch(()=>{});
    return;
  }
  await telegram(env,'answerCallbackQuery',{callback_query_id:callback.id,text:callback.message.chat.type==='private'?'':'Отправляю статистику в личный чат'}).catch(()=>{});
  return showStats(env,config,callback.from.id,callback.data,callback);
}
