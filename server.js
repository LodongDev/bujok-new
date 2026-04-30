#!/usr/bin/env node
// bujok-new 서버 — 웹 UI에서 로그인 → Chrome 자동 실행 → 공격 예약 + 스캐빈징
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP = require('./lib/cdp');
const { detectVillages } = require('./lib/farm');
const { evaluate } = require('./lib/runtime');
const { navigate, waitForLoad, sleep } = require('./lib/page');
const { getAvailableTroops } = require('./lib/place');
const Scheduler = require('./lib/scheduler');
const { scavengeAll } = require('./lib/scavenge');
const ScavengeQueue = require('./lib/scavenge-queue');
const { sellAllVillages } = require('./lib/market');
const MarketQueue = require('./lib/market-queue');
const { farmAllVillages } = require('./lib/farm-auto');
const FarmQueue = require('./lib/farm-queue');
const BuildingQueue = require('./lib/building-queue');
const { TrainerQueue, DEFAULT_PLAN: DEFAULT_TRAIN_PLAN } = require('./lib/trainer-queue');
const BotLock = require('./lib/bot-lock');
const ReportCollector = require('./lib/report-collector');
const { checkBotProtection } = require('./lib/bot-protection');
const persist = require('./lib/persist');
const { HCAPTCHA_SOLVER, GAME_BOT_SOLVER } = require('./lib/captcha-userscripts');
const { killAllChrome, launchChrome, waitForCDP, loginAndDetectServers, enterServer } = require('./lib/launcher');
const log = require('./lib/log');

// ==========================================
// CLI 인자
// ==========================================
function parseArgs() {
    const args = { port: 4001, cdpPort: 9222 };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port' && argv[i + 1]) args.port = parseInt(argv[++i]);
        else if (a === '--cdp-port' && argv[i + 1]) args.cdpPort = parseInt(argv[++i]);
        else if (a === '--help' || a === '-h') {
            console.log('사용법: node server.js [옵션]');
            console.log('  --port <port>      HTTP 포트 (기본 4001)');
            console.log('  --cdp-port <port>  CDP 포트 (기본 9222)');
            process.exit(0);
        }
    }
    return args;
}

// ==========================================
// 글로벌 상태
// ==========================================
const args = parseArgs();
let state = {
    phase: 'setup',     // 'setup' → 'launching' → 'logging_in' → 'select_server' → 'entering' → 'ready'
    server: null,
    servers: [],        // 감지된 서버 목록
    cdp: null,
    sessionId: null,    // 유저 탭 (로그인용 → 이후 유저가 자유 플레이)
    targetId: null,
    botSessionId: null, // 봇 전용 탭 (백그라운드 작업)
    botTargetId: null,
    scheduler: null,
    villages: [],
    scavengeRunning: false,
    scavQueue: null,
    marketQueue: null,
    marketRunning: false,
    farmQueue: null,
    farmRunning: false,
    buildQueue: null,
    buildPriorities: {},
    trainerQueue: null,
    trainPlan: null, // [{building, unit, count}] — 저장된 양성 계획
    reportCollector: null,
    botLock: new BotLock(),
    botProtection: null,    // { detected: true, type: '...', at: timestamp }
    iframeSessions: new Map(), // sessionId → { url, parentSessionId } — Target.attachedToTarget로 추적
    userPaused: false, // true면 모든 큐 정지 + 자동 복원/재시작 안 함 (사용자가 명시적으로 재개해야 함)
    startedAt: Date.now(), // 서버 시작 시각 — 클라이언트가 재시작 감지하는 데 사용
    error: null,
};

// 모든 큐를 일시정지 (persist는 유지 — 재개 시 복원 위해)
function pauseAllQueues() {
    state.scavQueue?.stop();
    state.marketQueue?.stop();
    state.farmQueue?.stop();
    state.buildQueue?.stop();
    state.trainerQueue?.stop();
    state.reportCollector?.stop();
    state.scavQueue = null;
    state.marketQueue = null;
    state.farmQueue = null;
    state.buildQueue = null;
    state.trainerQueue = null;
}

// 유저스크립트 자동 주입 비활성화 — hCaptcha 점수 시스템이 영구 setInterval/전역변수 감지
// 대신 캡차 감지될 때만 attemptAutoSolveCaptcha에서 진짜 OS 마우스 이벤트로 처리
async function injectCaptchaScripts(sessionId) {
    // no-op (의도적으로 비움)
}

function setupIframeAutoAttach() {
    if (!state.cdp || setupIframeAutoAttach._installed) return;
    setupIframeAutoAttach._installed = true;
    state.cdp.on((method, params, sessionId) => {
        if (method === 'Target.attachedToTarget') {
            const ti = params.targetInfo || {};
            if (ti.type === 'iframe') {
                state.iframeSessions.set(params.sessionId, {
                    url: ti.url || '',
                    parentSessionId: sessionId,
                    targetId: ti.targetId,
                });
                // iframe도 auto-attach + 캡차 스크립트 주입
                state.cdp.send('Target.setAutoAttach', {
                    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
                }, params.sessionId).catch(() => {});
                state.cdp.send('Runtime.enable', {}, params.sessionId).catch(() => {});
                // hCaptcha iframe이면 solver 주입
                if ((ti.url || '').includes('hcaptcha.com')) {
                    log.info(`[캡차] hCaptcha iframe 감지 — solver 주입`);
                    injectCaptchaScripts(params.sessionId);
                }
            }
        } else if (method === 'Target.detachedFromTarget') {
            state.iframeSessions.delete(params.sessionId);
        }
    });
}

async function enableAutoAttachOn(sessionId) {
    if (!state.cdp || !sessionId) return;
    setupIframeAutoAttach();
    await state.cdp.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, sessionId).catch(() => {});
    // 이 세션에도 캡차 스크립트 자동 주입 (모든 미래 페이지 로드에서 실행)
    await injectCaptchaScripts(sessionId);
}

// URL 패턴(부분 문자열)으로 iframe sessionId 찾기 — frame=checkbox 우선
function findIframeSession(urlSubstrings) {
    const subs = Array.isArray(urlSubstrings) ? urlSubstrings : [urlSubstrings];
    const matches = [];
    for (const [sid, info] of state.iframeSessions.entries()) {
        if (subs.some(s => info.url.includes(s))) matches.push({ sid, info });
    }
    if (matches.length === 0) return null;
    // frame=checkbox 우선 (challenge 프레임 회피)
    const checkbox = matches.find(m => m.info.url.includes('frame=checkbox'));
    if (checkbox) return checkbox;
    return matches[matches.length - 1];
}

// CDP로 직접 iframe 타겟 조회 — in-memory map이 비었을 때 fallback
async function discoverIframeTargets() {
    try {
        const { targetInfos } = await state.cdp.send('Target.getTargets');
        const iframes = (targetInfos || []).filter(t => t.type === 'iframe');
        // 새로 발견한 iframe은 attach
        for (const ti of iframes) {
            // 이미 우리 map에 있는지 확인
            const known = [...state.iframeSessions.values()].some(v => v.targetId === ti.targetId);
            if (known) continue;
            try {
                const { sessionId } = await state.cdp.send('Target.attachToTarget', {
                    targetId: ti.targetId, flatten: true,
                });
                state.iframeSessions.set(sessionId, { url: ti.url || '', targetId: ti.targetId });
                await state.cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
                log.info(`[캡차] iframe 수동 attach: ${(ti.url||'').slice(0, 80)}`);
            } catch (e) { /* 무시 */ }
        }
        return iframes.length;
    } catch (e) { return 0; }
}

// 봇 프로텍션 감지 시:
//   1. 모든 큐 정지
//   2. DOM 구조 덤프 저장 (captchas/)
//   3. 체크박스 자동 클릭 시도
//   4. 15초마다 해결됐는지 자동 확인
let botCheckPollTimer = null;
async function handleBotProtection(detail) {
    if (state.botProtection) return;
    state.botProtection = { ...detail, at: Date.now() };
    log.err(`🛑 봇 프로텍션 감지: ${detail.type} — 모든 자동 작업 정지`);
    state.scavQueue?.stop();
    state.marketQueue?.stop();
    state.farmQueue?.stop();
    state.buildQueue?.stop();
    state.trainerQueue?.stop();

    // 1. DOM 덤프 (분석용)
    try {
        const targetSession = state.botSessionId || state.sessionId;
        if (targetSession && state.cdp) {
            const dump = await captureBotcheckDom(state.cdp, targetSession);
            const fs = require('fs');
            const path = require('path');
            const dir = path.join(__dirname, 'captchas');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            const file = path.join(dir, `botcheck-${Date.now()}.json`);
            fs.writeFileSync(file, JSON.stringify(dump, null, 2));
            log.info(`[캡차] DOM 덤프 저장: captchas/${path.basename(file)}`);
        }
    } catch (e) { log.warn('[캡차] 덤프 실패: ' + e.message); }

    // 2. 타입별 자동 처리 분기
    if (detail.type === 'session_expired') {
        // 세션 만료는 캡차가 아님 — 게임 URL 재진입 시도
        log.info('[세션복구] session_expired → 자동 재진입 시도');
        try { await handleSessionExpired(); }
        catch (e) { log.warn('[세션복구] 실패: ' + e.message); }
    } else {
        // 일반 캡차 (bot_protection_row, hCaptcha 등)
        try { await attemptAutoSolveCaptcha(); }
        catch (e) { log.warn('[캡차] 자동 풀이 실패: ' + e.message); }
    }

    // 3. 주기적 해결 확인 (15초)
    if (botCheckPollTimer) clearInterval(botCheckPollTimer);
    botCheckPollTimer = setInterval(async () => {
        if (!state.botProtection || !state.cdp) return;
        try {
            const { checkBotProtection } = require('./lib/bot-protection');
            const targetSession = state.botSessionId || state.sessionId;
            const r = await checkBotProtection(state.cdp, targetSession);
            if (!r.detected) {
                log.ok(`✅ 캡차 해결 감지`);
                clearBotProtection();
            }
        } catch {}
    }, 15000);
}

// 캡차 뜬 순간의 DOM 정보 수집 (분석용)
async function captureBotcheckDom(cdp, sessionId) {
    return await evaluate(cdp, sessionId, `
        (() => {
            const info = { url: location.href, title: document.title, ts: new Date().toISOString() };
            info.iframes = [...document.querySelectorAll('iframe')].map(f => {
                const r = f.getBoundingClientRect();
                return { src: f.src, id: f.id, x: r.x, y: r.y, w: r.width, h: r.height, visible: f.offsetParent !== null };
            });
            info.captchaElements = [...document.querySelectorAll('[class*="hcaptcha"],[class*="captcha"],[class*="challenge"],[data-sitekey]')].slice(0, 15).map(el => {
                const r = el.getBoundingClientRect();
                return { tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0,150), x: r.x, y: r.y, w: r.width, h: r.height, sitekey: el.getAttribute('data-sitekey') };
            });
            info.bodyText = (document.body?.innerText || '').slice(0, 1500);
            return info;
        })()
    `);
}

// 봇 프로텍션 자동 클릭 — 두 userscript(hCaptcha Solver + Bot Solver) 검증 패턴 통합
//   * 게임 페이지: #botprotection_quest → a.btn.btn-default → fallback selectors
//   * hCaptcha iframe: #checkbox 또는 #anchor-state — Target.attachedToTarget로 받은 iframe sessionId에서 직접 실행
//   * 클릭은 항상 human-like 이벤트 체인 (mouseover→mousedown→대기→mouseup→click)
//   * 클릭 좌표는 요소 내부 랜덤 (정중앙 회피)
//   * 트랩(가짜 요소) 감지 — Proxy/조작된 getter 검출

// 인간형 클릭을 evaluate로 주입할 공통 IIFE — 어떤 sessionId(메인/iframe)에서도 동작
const HUMAN_CLICK_FN = `
function gauss(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  n = n / 10 + 0.5;
  if (n > 1 || n < 0) return Math.floor(Math.random() * (max - min + 1) + min);
  return Math.floor(n * (max - min + 1) + min);
}
function isTrap(el) {
  try {
    if (!el) return true;
    const ctor = el.constructor && el.constructor.name;
    if (ctor && ctor !== 'HTMLDivElement' && ctor !== 'HTMLElement' && ctor !== 'HTMLAnchorElement'
        && ctor !== 'HTMLButtonElement' && ctor !== 'HTMLInputElement' && ctor !== 'HTMLSpanElement') {
      return true;
    }
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'className');
    if (desc && desc.get && !desc.get.toString().includes('[native code]')) return true;
  } catch { return true; }
  return false;
}
function fireMouse(el, type, x, y) {
  el.dispatchEvent(new MouseEvent(type, {
    view: window, bubbles: true, cancelable: true,
    clientX: x, clientY: y, button: 0,
  }));
}
function humanClick(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + (Math.random() * r.width * 0.8) + r.width * 0.1;
  const y = r.top  + (Math.random() * r.height * 0.8) + r.height * 0.1;
  fireMouse(el, 'mouseover', x, y);
  fireMouse(el, 'mousedown', x, y);
  setTimeout(() => {
    fireMouse(el, 'mouseup', x, y);
    fireMouse(el, 'click', x, y);
  }, gauss(50, 150));
}
`;

// 게임 페이지에서 quest/시작 버튼 단계 시도
async function clickGamePageStep(sessionId, doneFlags) {
    const expr = `
        (() => {
            ${HUMAN_CLICK_FN}
            // 1. 퀘스트 아이콘
            const quest = document.getElementById('botprotection_quest');
            if (quest && quest.offsetParent !== null && !isTrap(quest) && !${doneFlags.quest}) {
                humanClick(quest);
                return { acted: 'quest' };
            }
            // 2. "Begin bot protection check" 시작 버튼 (a.btn.btn-default)
            const labels = ['Begin bot protection check', '봇 보호', 'Bot protection check'];
            const btn = [...document.querySelectorAll('a.btn.btn-default, .btn.btn-default')]
                .find(b => b.offsetParent !== null && labels.some(l => (b.textContent||'').includes(l)));
            if (btn && !isTrap(btn) && !${doneFlags.button}) {
                humanClick(btn);
                return { acted: 'button' };
            }
            // 3. fallback — submit/확인 버튼
            const submit = document.querySelector('input[type="submit"][value*="확인"], button[type="submit"]');
            if (submit && submit.offsetParent !== null && !isTrap(submit) && !${doneFlags.button}) {
                humanClick(submit);
                return { acted: 'submit' };
            }
            return { acted: null };
        })()
    `;
    return await evaluate(state.cdp, sessionId, expr).catch(() => ({ acted: null }));
}

// 특정 sessionId에서 #checkbox / #anchor-state 인간형 클릭 시도 — gaussian 반응 지연 후 실행
async function clickCheckboxIn(sessionId) {
    const expr = `
        (() => {
            ${HUMAN_CLICK_FN}
            const cb = document.getElementById('checkbox');
            if (cb && cb.offsetParent !== null && cb.getAttribute('aria-checked') === 'false' && !isTrap(cb)) {
                const wait = gauss(2000, 4500);
                setTimeout(() => humanClick(cb), wait);
                return { acted: 'checkbox', waitMs: wait };
            }
            const anchor = document.getElementById('anchor-state');
            if (anchor && anchor.offsetParent !== null && !isTrap(anchor)) {
                const wait = gauss(2000, 4500);
                setTimeout(() => humanClick(anchor), wait);
                return { acted: 'anchor', waitMs: wait };
            }
            return { acted: null };
        })()
    `;
    return await evaluate(state.cdp, sessionId, expr).catch(() => ({ acted: null }));
}

// 진짜 OS 마우스 이벤트로 자동 캡차 해결 (CDP Input.dispatchMouseEvent)
// fake JS .click() 대신 베지어 이동 + mousePressed/Released — hCaptcha 점수 회피
const mouse = require('./lib/mouse');

// 요소의 viewport 사각형 가져오기 — scrollIntoView 후 좌표 (place.js의 검증된 패턴)
// 좌표가 viewport 밖이면 마우스 이벤트가 다른 곳으로 가거나 무시되는 버그 방지
async function getElementRect(sessionId, selector) {
    const expr = `
        (() => {
            const el = ${selector};
            if (!el || el.offsetParent === null) return null;
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        })()
    `;
    const rect = await evaluate(state.cdp, sessionId, expr).catch(() => null);
    if (rect) {
        // scrollIntoView 후 좌표가 viewport 안에 있는지 검증
        const inView = rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0;
        if (!inView) return null;
    }
    return rect;
}

// 사각형 안 랜덤 좌표 (정중앙 회피)
function pickPointInRect(rect) {
    return {
        x: rect.x + rect.w * (0.3 + Math.random() * 0.4),
        y: rect.y + rect.h * (0.3 + Math.random() * 0.4),
    };
}

let lastMousePos = { x: 0, y: 0 };

async function realClickElement(sessionId, rect) {
    const target = pickPointInRect(rect);
    await mouse.moveAndClick(state.cdp, sessionId, lastMousePos, target);
    lastMousePos = target;
}

async function attemptAutoSolveCaptcha() {
    const targetSession = state.botSessionId || state.sessionId;
    if (!targetSession || !state.cdp) return;

    let elapsed = 0;
    const interval = 2500;
    const maxElapsed = 60000;
    const done = { quest: false, button: false, checkbox: false };

    const tick = async () => {
        if (state.botProtection === null || elapsed >= maxElapsed) return;
        try {
            // (a) 게임 페이지 — quest 아이콘
            if (!done.quest) {
                const rect = await getElementRect(targetSession,
                    `document.getElementById('botprotection_quest')`);
                if (rect) {
                    log.info(`[캡차] quest 발견 (${Math.round(rect.x)},${Math.round(rect.y)}) 클릭`);
                    await realClickElement(targetSession, rect);
                    done.quest = true;
                    elapsed += interval;
                    if (elapsed < maxElapsed) setTimeout(tick, interval + Math.floor(Math.random() * 1000));
                    return;
                }
            }
            // (b) "Begin bot protection check" 버튼 — 클릭 후 페이지 변화 검증
            // done.button을 검증 후에만 set (실패 시 다음 tick에서 재시도)
            if (!done.button) {
                const buttonSelector = `
                    [...document.querySelectorAll('a.btn.btn-default, .btn.btn-default, button[type="submit"], input[type="submit"]')]
                        .find(b => b.offsetParent !== null && (
                            (b.textContent||'').includes('Begin bot protection check') ||
                            (b.textContent||'').includes('봇 보호') ||
                            (b.value||'').includes('확인')
                        ))
                `;
                const rect = await getElementRect(targetSession, buttonSelector);
                if (rect) {
                    log.info(`[캡차] Begin 버튼 (${Math.round(rect.x)},${Math.round(rect.y)}) 클릭 시도`);
                    await realClickElement(targetSession, rect);
                    // JS .click() 백업 (마우스 이벤트가 무시됐을 경우 보강)
                    await sleep(500);
                    await evaluate(state.cdp, targetSession, `
                        (() => { const el = ${buttonSelector}; if (el) el.click(); })()
                    `).catch(() => {});
                    // 페이지 변화 검증: iframe[hcaptcha] 나타나거나 Begin 텍스트가 사라짐
                    await sleep(2000);
                    const changed = await evaluate(state.cdp, targetSession, `
                        (() => {
                            const hasIframe = !!document.querySelector('iframe[src*="hcaptcha.com"]');
                            const beginGone = !document.body?.innerText?.includes('Begin bot protection check');
                            return { hasIframe, beginGone };
                        })()
                    `).catch(() => ({ hasIframe: false, beginGone: false }));
                    if (changed.hasIframe || changed.beginGone) {
                        log.ok(`[캡차] Begin 클릭 성공 (iframe:${changed.hasIframe}, beginGone:${changed.beginGone})`);
                        done.button = true;
                    } else {
                        log.warn(`[캡차] Begin 클릭이 페이지 변화 없음 — 다음 tick에서 재시도`);
                    }
                    elapsed += interval;
                    if (elapsed < maxElapsed) setTimeout(tick, interval + Math.floor(Math.random() * 1000));
                    return;
                }
            }
            // (c) hCaptcha iframe — iframe 위치에서 checkbox 추정 좌표 클릭
            if (!done.checkbox) {
                const iframeRect = await getElementRect(targetSession, `
                    document.querySelector('iframe[src*="hcaptcha.com"][src*="frame=checkbox"]')
                    || document.querySelector('iframe[src*="hcaptcha.com"]')
                `);
                if (iframeRect) {
                    // hCaptcha 체크박스는 iframe 좌측 영역에 있음 (15~25% from left, 중앙)
                    const target = {
                        x: iframeRect.x + iframeRect.w * (0.10 + Math.random() * 0.10),
                        y: iframeRect.y + iframeRect.h * (0.40 + Math.random() * 0.20),
                    };
                    log.info(`[캡차] hCaptcha iframe 발견 — 체크박스 위치 추정 클릭`);
                    // 인간 반응 시간 시뮬레이션 (2~4초)
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                    await mouse.moveAndClick(state.cdp, targetSession, lastMousePos, target);
                    lastMousePos = target;
                    done.checkbox = true;
                }
            }
            // 해제 확인
            const { checkBotProtection } = require('./lib/bot-protection');
            const r = await checkBotProtection(state.cdp, targetSession, { skipDump: true });
            if (!r.detected) {
                log.ok(`[캡차] ✅ 자동 해결 완료 (${Math.round(elapsed/1000)}초)`);
                clearBotProtection();
                return;
            }
        } catch (e) { log.warn(`[캡차] tick 에러: ${e.message}`); }

        elapsed += interval;
        if (elapsed < maxElapsed) {
            setTimeout(tick, interval + Math.floor(Math.random() * 1000));
        } else {
            log.warn(`[캡차] ${maxElapsed/1000}초 시도 후에도 미해결 — 수동 필요`);
        }
    };
    setTimeout(tick, 1500 + Math.floor(Math.random() * 1500));
}

// 보고서 자동 수집 시작 (서버 진입 시)
function startReportCollector(serverName, baseUrl) {
    if (state.reportCollector) state.reportCollector.stop();
    state.reportCollector = new ReportCollector(
        state.cdp, state.botSessionId, baseUrl, serverName,
        state.scheduler, state.botLock,
    );
    state.reportCollector.start();
}

// 서버 진입 후 — state/<server>.json 에 저장된 큐 복원
// scavenge / market / farm / trainer / build / buildPriorities
async function restoreQueues() {
    if (!state.server) return;
    const saved = persist.load(state.server);
    if (!saved || Object.keys(saved).length === 0) return;

    // 사용자가 일시정지 상태면 큐 자동 복원 안 함 — 명시적 재개해야 동작
    if (saved.paused === true) {
        state.userPaused = true;
        log.info('[복원] 사용자 일시정지 상태 — 큐 자동 시작 안 함 (UI에서 재개 필요)');
        // buildPriorities는 복원 (메모리에 들고 있어야 재개 시 사용)
        if (saved.buildPriorities) state.buildPriorities = saved.buildPriorities;
        return;
    }

    const baseUrl = `https://${state.server}.tribalwars.net`;
    const validIds = new Set(state.villages.map(v => v.id));

    // buildPriorities 먼저 복원 (build 큐가 참조함)
    if (saved.buildPriorities && typeof saved.buildPriorities === 'object') {
        state.buildPriorities = saved.buildPriorities;
        log.info(`[복원] 건설 우선순위 ${Object.keys(saved.buildPriorities).length}개 마을`);
    }

    const pickVillages = (ids) => state.villages.filter(v => (ids || []).includes(v.id));

    if (saved.scavenge?.villageIds?.length) {
        try {
            const targets = pickVillages(saved.scavenge.villageIds);
            if (targets.length) {
                state.scavQueue = new ScavengeQueue(state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection);
                await state.scavQueue.start(targets);
                log.ok(`[복원] 스캐빈징 큐 — ${targets.length}개 마을`);
            }
        } catch (e) { log.warn(`[복원] 스캐빈징 실패: ${e.message}`); }
    }

    if (saved.market?.villageIds?.length) {
        try {
            const targets = pickVillages(saved.market.villageIds);
            if (targets.length) {
                state.marketQueue = new MarketQueue(state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection);
                await state.marketQueue.start(targets);
                log.ok(`[복원] 시장 큐 — ${targets.length}개 마을`);
            }
        } catch (e) { log.warn(`[복원] 시장 실패: ${e.message}`); }
    }

    if (saved.farm?.villageIds?.length) {
        try {
            const targets = pickVillages(saved.farm.villageIds);
            if (targets.length) {
                state.farmQueue = new FarmQueue(state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection);
                await state.farmQueue.start(targets, { mode: saved.farm.mode || 'C' });
                log.ok(`[복원] 동줍 큐 — ${targets.length}개 마을 (mode=${saved.farm.mode || 'C'})`);
            }
        } catch (e) { log.warn(`[복원] 동줍 실패: ${e.message}`); }
    }

    if (saved.trainer?.villageIds?.length) {
        try {
            const targets = pickVillages(saved.trainer.villageIds);
            const plan = saved.trainer.plan || DEFAULT_TRAIN_PLAN;
            if (targets.length) {
                state.trainPlan = plan;
                state.trainerQueue = new TrainerQueue(state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection);
                await state.trainerQueue.start(targets, plan);
                log.ok(`[복원] 양성 큐 — ${targets.length}개 마을`);
            }
        } catch (e) { log.warn(`[복원] 양성 실패: ${e.message}`); }
    }

    if (saved.build?.villageIds?.length) {
        try {
            state.buildQueue = new BuildingQueue(state.cdp, state.botSessionId, baseUrl,
                state.scheduler, state.botLock, handleBotProtection);
            let n = 0;
            for (const vid of saved.build.villageIds) {
                if (!validIds.has(vid)) continue;
                const priority = state.buildPriorities[vid];
                if (!priority || !priority.length) continue;
                const v = state.villages.find(vv => vv.id === vid);
                if (v) { state.buildQueue.setVillagePriority(vid, v.name, priority); n++; }
            }
            if (n) {
                await state.buildQueue.start();
                log.ok(`[복원] 건설 큐 — ${n}개 마을`);
            } else {
                state.buildQueue = null;
            }
        } catch (e) { log.warn(`[복원] 건설 실패: ${e.message}`); }
    }
}

// 저장된 자격증명으로 자동 재로그인 → 서버 재진입
// 쿠키 만료된 경우에도 무인 복구 가능
async function attemptAutoRelogin() {
    const creds = persist.loadCredentials();
    if (!creds || !creds.username || !creds.password) {
        log.warn('[자동로그인] 저장된 자격증명 없음 — 사용자 첫 로그인 후 가능');
        return false;
    }
    try {
        log.info(`[자동로그인] 저장된 ID로 재로그인 시도: ${creds.username}`);
        const result = await loginAndDetectServers(state.cdp, state.sessionId, creds.username, creds.password);
        if (!result.success) {
            log.warn(`[자동로그인] 로그인 실패: ${result.error}`);
            return false;
        }
        log.ok(`[자동로그인] 로그인 성공 — 서버 ${result.servers.length}개 감지`);
        // 원래 서버로 재진입 (page/play URL navigate)
        if (state.server && state.botSessionId) {
            const playUrl = `https://www.tribalwars.net/en-dk/page/play/${state.server}`;
            await navigate(state.cdp, state.botSessionId, playUrl);
            await waitForLoad(state.cdp, state.botSessionId, 15000);
            await sleep(2000);
            const url = await evaluate(state.cdp, state.botSessionId, 'location.href');
            if (url && url.includes(`${state.server}.tribalwars.net/game.php`)) {
                log.ok(`[자동로그인] 봇 탭 게임 진입 성공`);
                return true;
            }
            log.warn(`[자동로그인] 봇 탭 게임 진입 실패 — URL: ${url}`);
            return false;
        }
        return true;
    } catch (e) {
        log.warn(`[자동로그인] 예외: ${e.message}`);
        return false;
    }
}

// 세션 만료 자동 복구 — 봇/유저 탭을 게임 URL로 navigate
// 쿠키가 살아있으면 자동 재로그인, 만료됐으면 저장된 자격증명으로 자동 로그인
async function handleSessionExpired() {
    if (!state.cdp || !state.server) {
        log.warn('[세션복구] cdp/server 없음 — 스킵');
        return;
    }
    const playUrl = `https://www.tribalwars.net/en-dk/page/play/${state.server}`;

    // 봇 탭 재진입
    if (state.botSessionId) {
        try {
            await navigate(state.cdp, state.botSessionId, playUrl);
            await waitForLoad(state.cdp, state.botSessionId, 15000);
            await sleep(2000);
            const url = await evaluate(state.cdp, state.botSessionId, 'location.href');
            if (url && url.includes('game.php')) {
                log.ok(`[세션복구] 봇 탭 재진입 성공: ${url.slice(0, 80)}`);
            } else {
                // 쿠키도 만료 → 저장된 자격증명으로 자동 재로그인 시도
                log.warn(`[세션복구] 쿠키 만료 — 자동 재로그인 시도`);
                const ok = await attemptAutoRelogin();
                if (!ok) {
                    state.error = '세션 만료 — 자동 로그인 실패 (자격증명 없거나 비밀번호 변경?)';
                    log.err('[세션복구] 자동 로그인 실패 — 수동 로그인 필요');
                    return;
                }
            }
        } catch (e) {
            log.warn(`[세션복구] 봇 탭 navigate 실패: ${e.message}`);
            return;
        }
    }

    // 유저 탭도 같은 처리 (선택적 — 같은 쿠키 공유)
    if (state.sessionId && state.sessionId !== state.botSessionId) {
        try {
            await navigate(state.cdp, state.sessionId, playUrl);
            await waitForLoad(state.cdp, state.sessionId, 10000);
        } catch (e) { log.warn(`[세션복구] 유저 탭 navigate 실패: ${e.message}`); }
    }

    // 봇 프로텍션 해제 → 큐 자동 재시작 (clearBotProtection 안에서 restoreQueues)
    log.ok('[세션복구] ✅ 자동 재진입 완료');
    clearBotProtection();
}

function clearBotProtection() {
    if (!state.botProtection) return;
    const seconds = Math.round((Date.now() - state.botProtection.at) / 1000);
    state.botProtection = null;
    if (botCheckPollTimer) { clearInterval(botCheckPollTimer); botCheckPollTimer = null; }
    log.ok(`봇 프로텍션 해제 (${seconds}초 만에 해결)`);
    // 사용자 일시정지 상태면 자동 재시작 안 함
    if (state.userPaused) {
        log.info('[복구] 사용자 일시정지 상태 — 큐 자동 재시작 안 함');
        return;
    }
    // 정지됐던 큐들 자동 재시작 (persist에 저장된 설정으로 복원)
    if (state.phase === 'ready' && state.server) {
        log.info('[복구] 큐 자동 재시작...');
        // 모든 큐 참조 클리어 (restoreQueues가 새로 만듦)
        state.scavQueue = null;
        state.marketQueue = null;
        state.farmQueue = null;
        state.buildQueue = null;
        state.trainerQueue = null;
        restoreQueues().catch(e => log.warn(`[복구] 실패: ${e.message}`));
        // 보고서 수집기도 재시작
        if (state.reportCollector?.stopped) {
            state.reportCollector.start();
        }
    }
}

// ==========================================
// Chrome 실행 + 로그인 + 초기화
// ==========================================
// Step 1: Chrome 실행 + 로그인 + 서버 감지
async function launch(username, password) {
    state.phase = 'launching';
    state.error = null;

    try {
        killAllChrome();
        await sleep(2000);
        launchChrome(args.cdpPort);
        await waitForCDP('127.0.0.1', args.cdpPort);

        state.cdp = new CDP('127.0.0.1', args.cdpPort);
        await state.cdp.connect();

        const tab = await state.cdp.createTab('https://www.tribalwars.net');
        state.targetId = tab.targetId;
        state.sessionId = tab.sessionId;
        await state.cdp.send('Page.enable', {}, state.sessionId).catch(() => {});
        await state.cdp.send('Runtime.enable', {}, state.sessionId).catch(() => {});
        await enableAutoAttachOn(state.sessionId);
        await sleep(1000);

        state.phase = 'logging_in';
        const result = await loginAndDetectServers(state.cdp, state.sessionId, username, password);

        if (!result.success) {
            if (result.error === 'captcha') {
                state.phase = 'captcha';
                state.error = result.message;
                return { success: false, phase: 'captcha', message: result.message };
            }
            throw new Error(result.error);
        }

        state.servers = result.servers;
        state.phase = 'select_server';
        // 로그인 성공 시 자격증명 저장 (세션 만료 시 자동 재로그인용)
        try { persist.saveCredentials(username, password); } catch {}
        return { success: true, phase: 'select_server', servers: result.servers };

    } catch (e) {
        state.phase = 'setup';
        state.error = e.message;
        log.err(`실행 실패: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// Step 2: 서버 선택 → 유저 탭 + 봇 탭 각각 접속 → 마을 감지
// 캡처 확인: 같은 Chrome에서 탭 2개는 세션 공유됨 (충돌 없음)
// 핵심: game.php 직접 접속 안 됨 → page/play/{서버} 경로로 접속해야 함
async function selectServer(serverName) {
    state.phase = 'entering';
    state.server = serverName;
    restartCaptureForServer(); // 새 서버 필터로 캡처 재시작
    const baseUrl = `https://${serverName}.tribalwars.net`;
    const playUrl = `https://www.tribalwars.net/en-dk/page/play/${serverName}`;

    try {
        // 1. 유저 탭 → 서버 접속 (page/play 경로)
        log.info('유저 탭 → 서버 접속...');
        await navigate(state.cdp, state.sessionId, playUrl);
        await waitForLoad(state.cdp, state.sessionId);
        await sleep(3000);

        // 2. 봇 전용 탭 생성 → page/play 경로로 접속
        log.info('봇 전용 탭 생성...');
        const botTab = await state.cdp.createTab(playUrl);
        state.botSessionId = botTab.sessionId;
        state.botTargetId = botTab.targetId;
        await state.cdp.send('Page.enable', {}, state.botSessionId).catch(() => {});
        await state.cdp.send('Runtime.enable', {}, state.botSessionId).catch(() => {});
        await enableAutoAttachOn(state.botSessionId);

        // 봇 탭 게임 접속 대기 (최대 15초)
        let botReady = false;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            try {
                const url = await evaluate(state.cdp, state.botSessionId, 'location.href');
                const hasMenu = await evaluate(state.cdp, state.botSessionId,
                    '!!document.querySelector("#menu_row, #menu_row2")');
                log.info(`봇 탭 [${i+1}]: ${url.substring(0,60)} menu=${hasMenu}`);
                if (url.includes('game.php') && hasMenu) {
                    botReady = true;
                    break;
                }
            } catch (e) {
                log.debug(`봇 탭 [${i+1}]: ${e.message}`);
            }
        }
        if (!botReady) {
            const finalUrl = await evaluate(state.cdp, state.botSessionId, 'location.href').catch(() => 'unknown');
            throw new Error(`봇 탭 접속 실패 (URL: ${finalUrl})`);
        }
        log.ok('봇 전용 탭 준비 완료');

        // 3. 봇 탭에서 마을 감지
        state.phase = 'detecting';
        state.villages = await detectVillages(state.cdp, state.botSessionId, baseUrl);
        log.ok(`마을 ${state.villages.length}개 감지`);

        // 4. 스케줄러도 봇 탭 사용
        state.scheduler = new Scheduler(state.cdp, state.botSessionId, baseUrl);
        state.scheduler.start();

        state.phase = 'ready';
        log.ok(`${serverName} 준비 완료! (유저 탭: 자유 플레이, 봇 탭: 백그라운드)`);
        startReportCollector(serverName, baseUrl);
        await restoreQueues();
        return { success: true };
    } catch (e) {
        // 봇 프로텍션은 탭 닫지 않고 유저 해결 대기
        if (e.botProtection) {
            handleBotProtection(e.botProtection);
            state.phase = 'captcha';
            state.error = '캡차 감지 — Chrome에서 해결해주세요';
            log.warn('[서버선택] 봇 프로텍션 감지 → 탭 유지, 유저 해결 대기');
            return { success: false, phase: 'captcha', message: state.error };
        }
        state.phase = 'select_server';
        state.error = e.message;
        if (state.botTargetId) {
            await state.cdp.closeTab(state.botTargetId).catch(() => {});
            state.botSessionId = null;
            state.botTargetId = null;
        }
        return { success: false, error: e.message };
    }
}

// 캡차 풀은 후 재시도
async function retryAfterCaptcha() {
    if (state.phase !== 'captcha' || !state.cdp) return { success: false, error: '상태 오류' };
    try {
        const result = await loginAndDetectServers(state.cdp, state.sessionId, '', '');
        if (result.success) {
            state.servers = result.servers;
            state.phase = 'select_server';
            return { success: true, phase: 'select_server', servers: result.servers };
        }
        return { success: false, error: result.error };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ==========================================
// 마을별 병력 조회
// ==========================================
async function getTroopsForVillage(villageId) {
    if (!state.cdp || state.phase !== 'ready') return {};
    const baseUrl = `https://${state.server}.tribalwars.net`;
    try {
        // 캡처 검증된 endpoint: ajax=home_units → JSON {response: {spear:N, sword:N, ...}}
        const result = await evaluate(state.cdp, state.botSessionId, `
            (async () => {
                try {
                    const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=place&ajax=home_units', {
                        headers: { 'TribalWars-Ajax': '1', 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    const text = await res.text();
                    if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON' };
                    return { ok: true, data: JSON.parse(text) };
                } catch (e) { return { ok: false, error: e.message }; }
            })()
        `);
        if (result?.ok && result.data?.response) {
            // {spear: 69, sword: 15, ...} 형식 그대로 반환
            const r = result.data.response;
            return {
                spear: r.spear || 0, sword: r.sword || 0, axe: r.axe || 0,
                archer: r.archer || 0, spy: r.spy || 0,
                light: r.light || 0, marcher: r.marcher || 0, heavy: r.heavy || 0,
                ram: r.ram || 0, catapult: r.catapult || 0,
                knight: r.knight || 0, snob: r.snob || 0, militia: r.militia || 0,
            };
        }
        // 폴백: 페이지 이동 방식 (봇 탭에서)
        await navigate(state.cdp, state.botSessionId, `${baseUrl}/game.php?village=${villageId}&screen=place`);
        await waitForLoad(state.cdp, state.botSessionId);
        await sleep(300);
        return await getAvailableTroops(state.cdp, state.botSessionId);
    } catch { return {}; }
}

// ==========================================
// HTTP 서버
// ==========================================
function startServer() {
    const publicDir = path.join(__dirname, 'public');

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${args.port}`);
        const pathname = url.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        // 모든 응답에 서버 시작 시각 포함 — 클라이언트가 재시작 감지
        res.setHeader('X-Server-Started-At', String(state.startedAt));
        // 정적 파일/JSON 모두 캐시 무효화 (개발 중 코드 변경 즉시 반영)
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        // ---- 셋업/런치 API ----

        // GET /api/state — 현재 상태 (모든 응답에 startedAt 포함 — 클라이언트가 서버 재시작 감지)
        if (pathname === '/api/state' && req.method === 'GET') {
            json(res, {
                phase: state.phase,
                server: state.server,
                servers: state.servers,
                villageCount: state.villages.length,
                userPaused: state.userPaused,
                startedAt: state.startedAt,
                error: state.error,
            });
            return;
        }

        // POST /api/pause — 모든 큐 일시정지 (persist 유지, 재개 시 복원)
        if (pathname === '/api/pause' && req.method === 'POST') {
            state.userPaused = true;
            pauseAllQueues();
            persist.setKey(state.server, 'paused', true);
            log.info('[일시정지] 사용자 요청으로 모든 큐 정지');
            json(res, { success: true, userPaused: true });
            return;
        }

        // POST /api/resume — 일시정지 해제 + 세션 검증 + 큐 자동 복원
        if (pathname === '/api/resume' && req.method === 'POST') {
            state.userPaused = false;
            persist.setKey(state.server, 'paused', false);
            log.info('[재개] 세션 검증 시작...');

            // 1. 봇 탭이 게임 페이지에 있는지 확인 — 다른 곳에서 로그인했으면 세션 만료됐을 수 있음
            let sessionOk = false;
            try {
                if (state.botSessionId && state.cdp) {
                    const url = await evaluate(state.cdp, state.botSessionId, 'location.href').catch(() => '');
                    if (url && url.includes(`${state.server}.tribalwars.net/game.php`)) {
                        sessionOk = true;
                    } else {
                        // 만료된 듯 → 재진입 시도
                        log.info(`[재개] 봇 탭 URL: ${(url||'').slice(0,80)} — 세션 재진입 시도`);
                        const playUrl = `https://www.tribalwars.net/en-dk/page/play/${state.server}`;
                        await navigate(state.cdp, state.botSessionId, playUrl);
                        await waitForLoad(state.cdp, state.botSessionId, 15000);
                        await sleep(2000);
                        const url2 = await evaluate(state.cdp, state.botSessionId, 'location.href').catch(() => '');
                        if (url2 && url2.includes('game.php')) {
                            sessionOk = true;
                            log.ok(`[재개] 세션 재진입 성공`);
                        } else {
                            // 쿠키 만료 → 저장된 자격증명으로 자동 재로그인 시도
                            log.warn(`[재개] 쿠키 만료 — 자동 재로그인 시도`);
                            const ok = await attemptAutoRelogin();
                            if (ok) {
                                sessionOk = true;
                                log.ok('[재개] 자동 재로그인 + 게임 재진입 성공');
                            } else {
                                state.error = '자동 로그인 실패 — 자격증명 확인 필요';
                                json(res, { success: false, error: '자동 로그인 실패. 자격증명이 잘못되었거나 비밀번호가 변경되었을 수 있습니다.', sessionExpired: true });
                                return;
                            }
                        }
                    }
                }
            } catch (e) {
                log.warn(`[재개] 세션 검증 에러: ${e.message}`);
            }

            // 2. 큐 자동 복원
            log.info('[재개] 큐 자동 복원...');
            try {
                await restoreQueues();
                if (state.server && state.botSessionId) {
                    const baseUrl = `https://${state.server}.tribalwars.net`;
                    startReportCollector(state.server, baseUrl);
                }
            } catch (e) { log.warn(`[재개] 복원 실패: ${e.message}`); }
            json(res, { success: true, userPaused: false, sessionOk });
            return;
        }

        // POST /api/launch — Chrome 실행 + 로그인 + 서버 감지
        if (pathname === '/api/launch' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            if (!body.username || !body.password) {
                json(res, { success: false, error: '아이디, 비밀번호 필요' }, 400);
                return;
            }
            const result = await launch(body.username, body.password);
            json(res, result);
            return;
        }

        // POST /api/select-server — 서버 선택 → 접속
        if (pathname === '/api/select-server' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            if (!body.server) { json(res, { success: false, error: '서버 선택 필요' }, 400); return; }
            const result = await selectServer(body.server);
            json(res, result);
            return;
        }

        // POST /api/retry-captcha — 캡차 후 재시도
        if (pathname === '/api/retry-captcha' && req.method === 'POST') {
            const result = await retryAfterCaptcha();
            json(res, result);
            return;
        }

        // ---- 아래 API는 phase='ready'일 때만 ----

        if (state.phase !== 'ready') {
            if (pathname.startsWith('/api/')) {
                json(res, { error: '아직 준비 안 됨 (phase=' + state.phase + ')' }, 503);
                return;
            }
        }

        // GET /api/villages
        if (pathname === '/api/villages' && req.method === 'GET') {
            json(res, { villages: state.villages });
            return;
        }

        // GET /api/villages/:id/troops
        if (pathname.match(/^\/api\/villages\/\d+\/troops$/) && req.method === 'GET') {
            const vid = parseInt(pathname.split('/')[3]);
            const troops = await getTroopsForVillage(vid);
            json(res, { troops });
            return;
        }

        // POST /api/schedule — body: 일반 schedule 데이터 + 선택적 templateId
        // templateId 있으면 템플릿 병력 사용 + 마을 보유량으로 clamp
        if (pathname === '/api/schedule' && req.method === 'POST') {
            if (!state.scheduler) { json(res, { success: false, error: '스케줄러 없음' }); return; }
            const body = JSON.parse(await readBody(req));

            // 템플릿 적용
            if (body.templateId) {
                const templates = persist.loadTemplates(state.server);
                const tpl = templates.find(t => t.id === body.templateId);
                if (!tpl) { json(res, { success: false, error: '템플릿 없음' }); return; }
                // 템플릿 병력 사용
                body.troops = { ...tpl.troops };
            }

            // 마을 보유 병력으로 clamp (넘치면 가능한 만큼만)
            if (body.troops && body.sourceVillageId) {
                try {
                    const available = await getTroopsForVillage(body.sourceVillageId);
                    const clamped = {};
                    let didClamp = false;
                    for (const [unit, count] of Object.entries(body.troops)) {
                        const have = available[unit] || 0;
                        const use = Math.min(count, have);
                        if (use < count) didClamp = true;
                        clamped[unit] = use;
                    }
                    body.troops = clamped;
                    body._clamped = didClamp;
                    body._availableSnapshot = available;
                } catch (e) {
                    log.warn(`[예약] clamp 실패 (마을 ${body.sourceVillageId}): ${e.message}`);
                }
            }

            const atk = state.scheduler.schedule(body);
            json(res, { success: true, id: atk.id, clamped: body._clamped, troops: body.troops });
            return;
        }

        // POST /api/villages/refresh — 마을 목록 재감지 (수동 새로고침)
        if (pathname === '/api/villages/refresh' && req.method === 'POST') {
            if (!state.cdp || !state.botSessionId || !state.server) {
                json(res, { success: false, error: '서버 연결 안 됨' }); return;
            }
            try {
                const baseUrl = `https://${state.server}.tribalwars.net`;
                state.villages = await detectVillages(state.cdp, state.botSessionId, baseUrl);
                json(res, { success: true, villages: state.villages });
            } catch (e) {
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/train/immediate — 즉시 트레인 (지금 바로 발사)
        // body: { sourceVillageIds:[], targets:[{x,y}], templateIds:[], type? }
        // 동작: place 페이지 이동 → 폼 입력 → 진짜 마우스 클릭 → confirm 클릭 → 다음
        // 캡처 검증된 place.js의 gotoPlace/fillForm/clickAttack/clickConfirm 그대로 사용
        if (pathname === '/api/train/immediate' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const { sourceVillageIds = [], targets = [], waves = [], type = 'attack' } = body;
            if (!sourceVillageIds.length || !targets.length || !waves.length) {
                json(res, { success: false, error: '마을/타겟/웨이브 모두 필요' }); return;
            }
            // waves: [{name, troops}, ...] — 각 웨이브가 직접 troops 들고있음
            // 마을별 보유 병력 (웨이브 사이 차감 추적)
            const villageBudget = {};
            for (const sid of sourceVillageIds) {
                try { villageBudget[sid] = await getTroopsForVillage(sid); }
                catch { villageBudget[sid] = {}; }
            }
            // 마을 × 웨이브 = 총 공격 수, 타겟은 셔플+순환 랜덤 분배
            const shuffledImmTargets = [...targets].sort(() => Math.random() - 0.5);
            const totalAttacks = sourceVillageIds.length * waves.length;
            // 응답을 빨리 보내고 백그라운드에서 발사 (사용자 화면 안 멈춤)
            json(res, { success: true, message: '백그라운드에서 발사 시작', count: totalAttacks });
            // 실제 발사 — 비동기
            (async () => {
                const baseUrl = `https://${state.server}.tribalwars.net`;
                let fireSent = 0, fireSkipped = 0, fireFailed = 0;
                const lastMouse = { x: 500, y: 300 };
                let jobIdx = 0;
                for (const sid of sourceVillageIds) {
                    const sv = state.villages.find(v => v.id === sid);
                    if (!sv) continue;
                    for (let w = 0; w < waves.length; w++) {
                        const t = shuffledImmTargets[jobIdx % shuffledImmTargets.length];
                        jobIdx++;
                        const tpl = waves[w];
                            const budget = villageBudget[sid] || {};
                            const troops = {};
                            let total = 0;
                            for (const [u, n] of Object.entries(tpl.troops)) {
                                const have = budget[u] || 0;
                                const use = Math.min(n, have);
                                if (use > 0) { troops[u] = use; budget[u] = have - use; total += use; }
                            }
                            if (total === 0) { fireSkipped++; continue; }
                            try {
                                // 캡처 검증된 place.js 함수만 사용 — scheduler.js와 동일 흐름
                                const { gotoPlace, fillForm, clickAttack, clickSupport, waitForConfirm, clickConfirmOk } = require('./lib/place');
                                await gotoPlace(state.cdp, state.botSessionId, baseUrl, sid);
                                await fillForm(state.cdp, state.botSessionId, t.x, t.y, troops);
                                await sleep(randInt(400, 900));
                                let postClickMouse;
                                if (type === 'support') {
                                    postClickMouse = await clickSupport(state.cdp, state.botSessionId, lastMouse);
                                } else {
                                    postClickMouse = await clickAttack(state.cdp, state.botSessionId, lastMouse);
                                }
                                // confirm 화면 대기 → clickConfirmOk로 발사 (scheduler.js와 동일)
                                const confirmBtn = await waitForConfirm(state.cdp, state.botSessionId);
                                await sleep(randInt(200, 600));
                                await clickConfirmOk(state.cdp, state.botSessionId, confirmBtn, postClickMouse || lastMouse);
                                fireSent++;
                                log.ok(`[트레인즉시] ${sv.name}→(${t.x}|${t.y}) [W${w+1}:${tpl.name}] 발사`);
                                await sleep(randInt(800, 1800));
                            } catch (e) {
                                fireFailed++;
                                log.warn(`[트레인즉시] ${sv.name}→(${t.x}|${t.y}) 실패: ${e.message}`);
                            }
                    }
                }
                log.info(`[트레인즉시] 완료 — 발사 ${fireSent}, 스킵 ${fireSkipped}, 실패 ${fireFailed}`);
            })().catch(e => log.err('[트레인즉시] 백그라운드 에러: ' + e.message));
            return;
        }

        // POST /api/schedule/train — 트레인 (다중 웨이브)
        // body: { sourceVillageIds:[], targets:[{x,y}], templateIds:[] (웨이브 N개), arrivalStart:ISO, arrivalEnd:ISO, type?:'attack'|'support' }
        // 동작: (source × target × template) 각 조합 = 1개 공격 = 1개 웨이브
        //       각 마을의 보유 병력은 웨이브 사이에 차감 추적 (같은 마을이 4웨이브면 병력이 분배됨)
        // 캡처 검증: scheduler.schedule()이 confirm 페이지 Duration으로 fire 계산함 (검증된 흐름)
        if (pathname === '/api/schedule/train' && req.method === 'POST') {
            if (!state.scheduler) { json(res, { success: false, error: '스케줄러 없음' }); return; }
            const body = JSON.parse(await readBody(req));
            const { sourceVillageIds = [], targets = [], waves = [], arrivalStart, arrivalEnd, type = 'attack' } = body;

            if (!sourceVillageIds.length) { json(res, { success: false, error: '출발 마을 필요' }); return; }
            if (!targets.length) { json(res, { success: false, error: '타겟 좌표 필요' }); return; }
            if (!waves.length) { json(res, { success: false, error: '웨이브 1개 이상 필요' }); return; }
            const startMs = new Date(arrivalStart).getTime();
            const endMs = new Date(arrivalEnd).getTime();
            if (!startMs || !endMs || endMs <= startMs) {
                json(res, { success: false, error: '시간창 잘못됨' }); return;
            }
            // waves: [{name, troops}, ...] — 각 웨이브가 직접 troops 들고있음

            // 마을별 현재 보유 병력 미리 fetch — 웨이브 사이에 차감 추적
            const villageBudget = {}; // villageId → { spear:N, ... }
            for (const sid of sourceVillageIds) {
                try { villageBudget[sid] = await getTroopsForVillage(sid); }
                catch { villageBudget[sid] = {}; }
            }

            // 마을 × 웨이브 = 총 공격 수, 타겟은 랜덤 분배 (셔플+순환)
            // 예: 4마을 × 1웨이브 = 4공격, 타겟 3개 → 셔플된 타겟 리스트 cycling
            const shuffledTargets = [...targets].sort(() => Math.random() - 0.5);
            const jobs = [];
            let jobIdx = 0;
            for (const sid of sourceVillageIds) {
                const sv = state.villages.find(v => v.id === sid);
                if (!sv) continue;
                for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
                    const t = shuffledTargets[jobIdx % shuffledTargets.length];
                    jobs.push({ sourceVillage: sv, target: t, template: waves[waveIdx], waveIdx });
                    jobIdx++;
                }
            }
            if (!jobs.length) { json(res, { success: false, error: '유효한 조합 없음' }); return; }

            // 모드 분기:
            //  - 'window' (기본): 시간창 안에 분산 + 순서 셔플 (일반 트레인)
            //  - 'sequence' (노블 트레인): startMs부터 spacingMs 간격으로 순서 유지
            const mode = body.distMode || 'window';
            const spacingMs = parseInt(body.spacingMs) || 250; // 노블 트레인 기본 250ms
            const N = jobs.length;

            // jobs 정렬 — sequence 모드는 source > target > wave 순으로 안정 정렬 (셔플 X)
            const ordered = mode === 'sequence'
                ? [...jobs] // 입력 순서 유지 (waveIdx 순)
                : [...jobs].sort(() => Math.random() - 0.5); // 셔플

            const scheduled = [];
            for (let i = 0; i < N; i++) {
                const job = ordered[i];
                let arrivalMs;
                if (mode === 'sequence') {
                    // 정확한 간격 + 작은 지터 (±10ms 자연스러움)
                    const jitter = (Math.random() - 0.5) * 20;
                    arrivalMs = startMs + i * spacingMs + jitter;
                } else {
                    // window 모드: 슬롯 균등 분배 + 슬롯 내 랜덤
                    const slot = (endMs - startMs) / N;
                    const slotStart = startMs + slot * i;
                    const margin = slot * 0.1;
                    arrivalMs = slotStart + margin + Math.random() * (slot - 2 * margin);
                }

                // 해당 마을 잔여 병력에서 템플릿 clamp + 차감
                const budget = villageBudget[job.sourceVillage.id] || {};
                const troops = {};
                let total = 0;
                for (const [u, n] of Object.entries(job.template.troops)) {
                    const have = budget[u] || 0;
                    const use = Math.min(n, have);
                    if (use > 0) {
                        troops[u] = use;
                        budget[u] = have - use; // 차감 (다음 웨이브가 못 쓰게)
                        total += use;
                    }
                }

                if (total === 0) {
                    scheduled.push({
                        source: job.sourceVillage.id,
                        target: job.target,
                        wave: job.waveIdx,
                        template: job.template.name,
                        skipped: '병력 없음 (이전 웨이브에서 소진)',
                    });
                    continue;
                }

                const atk = state.scheduler.schedule({
                    type,
                    sourceVillageId: job.sourceVillage.id,
                    sourceX: job.sourceVillage.x,
                    sourceY: job.sourceVillage.y,
                    sourceName: `${job.sourceVillage.name} [W${job.waveIdx + 1}/${waves.length}:${job.template.name}]`,
                    targetX: job.target.x,
                    targetY: job.target.y,
                    troops,
                    arrivalTime: Math.round(arrivalMs),
                });
                scheduled.push({
                    id: atk.id,
                    source: job.sourceVillage.id,
                    target: job.target,
                    wave: job.waveIdx,
                    template: job.template.name,
                    arrivalAt: new Date(arrivalMs).toISOString(),
                });
            }

            const okCount = scheduled.filter(s => s.id).length;
            const skipCount = scheduled.filter(s => s.skipped).length;
            log.info(`[트레인] ${okCount}개 예약 (스킵 ${skipCount}개, 시간창 ${Math.round((endMs-startMs)/1000)}초, 웨이브 ${waves.length})`);
            json(res, { success: true, scheduled });
            return;
        }

        // GET /api/templates — 템플릿 목록
        if (pathname === '/api/templates' && req.method === 'GET') {
            json(res, { templates: persist.loadTemplates(state.server) });
            return;
        }
        // POST /api/templates — 템플릿 생성/수정 (body: {id?, name, troops})
        if (pathname === '/api/templates' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            if (!body.name || !body.troops) { json(res, { success: false, error: 'name + troops 필요' }); return; }
            const templates = persist.loadTemplates(state.server);
            if (body.id) {
                const idx = templates.findIndex(t => t.id === body.id);
                if (idx >= 0) templates[idx] = { ...templates[idx], name: body.name, troops: body.troops };
                else templates.push({ id: body.id, name: body.name, troops: body.troops });
            } else {
                const newId = Date.now().toString(36);
                templates.push({ id: newId, name: body.name, troops: body.troops });
                body.id = newId;
            }
            persist.saveTemplates(state.server, templates);
            json(res, { success: true, id: body.id });
            return;
        }
        // DELETE /api/templates/:id
        if (pathname.match(/^\/api\/templates\/[^/]+$/) && req.method === 'DELETE') {
            const id = pathname.split('/').pop();
            const templates = persist.loadTemplates(state.server).filter(t => t.id !== id);
            persist.saveTemplates(state.server, templates);
            json(res, { success: true });
            return;
        }

        // GET /api/scheduled
        if (pathname === '/api/scheduled' && req.method === 'GET') {
            json(res, { attacks: state.scheduler ? state.scheduler.list() : [] });
            return;
        }

        // DELETE /api/schedule/:id
        if (pathname.match(/^\/api\/schedule\/\d+$/) && req.method === 'DELETE') {
            if (!state.scheduler) { json(res, { success: false, error: '스케줄러 없음' }); return; }
            const id = parseInt(pathname.split('/').pop());
            json(res, { success: state.scheduler.cancel(id) });
            return;
        }

        // POST /api/scavenge/run — body: { villageIds: [...], auto: bool }
        if (pathname === '/api/scavenge/run' && req.method === 'POST') {
            const baseUrl = `https://${state.server}.tribalwars.net`;
            try {
                const body = JSON.parse(await readBody(req));
                const selectedIds = body.villageIds || [];
                const autoMode = body.auto || false;
                const targetVillages = selectedIds.length > 0
                    ? state.villages.filter(v => selectedIds.includes(v.id))
                    : state.villages;

                if (autoMode) {
                    // 큐 모드 — 마을별 개별 타이머 (스케줄러 우선순위 존중)
                    if (state.scavQueue) state.scavQueue.stop();
                    state.scavQueue = new ScavengeQueue(
                        state.cdp, state.botSessionId, baseUrl,
                        state.scheduler,
                        state.botLock,
                        handleBotProtection
                    );
                    await state.scavQueue.start(targetVillages);
                    persist.setKey(state.server, 'scavenge', { villageIds: targetVillages.map(v => v.id) });
                    log.ok('[스캐빈징 자동] 큐 시작');
                    json(res, { success: true, auto: true, status: state.scavQueue.status() });
                } else {
                    // 1회 실행 (즉시)
                    if (state.scavengeRunning) { json(res, { success: false, error: '이미 실행 중' }); return; }
                    state.scavengeRunning = true;
                    const { results } = await scavengeAll(state.cdp, state.botSessionId, baseUrl, targetVillages);
                    state.scavengeRunning = false;
                    json(res, { success: true, results, auto: false });
                }
            } catch (e) {
                state.scavengeRunning = false;
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/scavenge/auto-stop — 큐 중지
        if (pathname === '/api/scavenge/auto-stop' && req.method === 'POST') {
            if (state.scavQueue) {
                state.scavQueue.stop();
                state.scavQueue = null;
            }
            persist.setKey(state.server, 'scavenge', null);
            log.ok('[스캐빈징 자동] 중지');
            json(res, { success: true });
            return;
        }

        // GET /api/scavenge/status — 큐 상태 (UI 모니터링용)
        if (pathname === '/api/scavenge/status' && req.method === 'GET') {
            json(res, state.scavQueue ? state.scavQueue.status() : { running: false, size: 0, items: [] });
            return;
        }

        // POST /api/scavenge/update-selection — 큐 마을 선택 동적 변경
        if (pathname === '/api/scavenge/update-selection' && req.method === 'POST') {
            try {
                const body = JSON.parse(await readBody(req));
                const villageIds = body.villageIds || [];
                if (!state.scavQueue) { json(res, { success: false, error: '큐가 없음' }); return; }
                state.scavQueue.updateSelection(villageIds);
                persist.setKey(state.server, 'scavenge', { villageIds });
                json(res, { success: true, status: state.scavQueue.status() });
            } catch (e) {
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/market/run — body: { villageIds: [...], auto: bool }
        if (pathname === '/api/market/run' && req.method === 'POST') {
            const baseUrl = `https://${state.server}.tribalwars.net`;
            try {
                const body = JSON.parse(await readBody(req));
                const selectedIds = body.villageIds || [];
                const autoMode = body.auto || false;
                const targetVillages = selectedIds.length > 0
                    ? state.villages.filter(v => selectedIds.includes(v.id))
                    : state.villages;

                if (autoMode) {
                    if (state.marketQueue) state.marketQueue.stop();
                    state.marketQueue = new MarketQueue(
                        state.cdp, state.botSessionId, baseUrl,
                        state.scheduler,
                        state.botLock,
                        handleBotProtection
                    );
                    await state.marketQueue.start(targetVillages);
                    persist.setKey(state.server, 'market', { villageIds: targetVillages.map(v => v.id) });
                    log.ok('[시장 자동] 큐 시작');
                    json(res, { success: true, auto: true });
                } else {
                    if (state.marketRunning) { json(res, { success: false, error: '이미 실행 중' }); return; }
                    state.marketRunning = true;
                    const { results, totalPP } = await sellAllVillages(state.cdp, state.botSessionId, baseUrl, targetVillages);
                    state.marketRunning = false;
                    json(res, { success: true, results, totalPP });
                }
            } catch (e) {
                state.marketRunning = false;
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/market/auto-stop
        if (pathname === '/api/market/auto-stop' && req.method === 'POST') {
            if (state.marketQueue) { state.marketQueue.stop(); state.marketQueue = null; }
            persist.setKey(state.server, 'market', null);
            log.ok('[시장 자동] 중지');
            json(res, { success: true });
            return;
        }

        // GET /api/market/status
        if (pathname === '/api/market/status' && req.method === 'GET') {
            json(res, state.marketQueue ? state.marketQueue.status() : { running: false, stopped: true });
            return;
        }

        // POST /api/farm/run — body: { villageIds, template: 'A'|'B', auto: bool }
        if (pathname === '/api/farm/run' && req.method === 'POST') {
            const baseUrl = `https://${state.server}.tribalwars.net`;
            try {
                const body = JSON.parse(await readBody(req));
                const selectedIds = body.villageIds || [];
                const autoMode = body.auto || false;
                const mode = body.mode || 'C'; // 'C' | 'A' | 'B' | 'C_OR_A'
                const targetVillages = selectedIds.length > 0
                    ? state.villages.filter(v => selectedIds.includes(v.id))
                    : state.villages;

                if (autoMode) {
                    if (state.farmQueue) state.farmQueue.stop();
                    state.farmQueue = new FarmQueue(
                        state.cdp, state.botSessionId, baseUrl,
                        state.scheduler, state.botLock, handleBotProtection
                    );
                    await state.farmQueue.start(targetVillages, { mode });
                    persist.setKey(state.server, 'farm', { villageIds: targetVillages.map(v => v.id), mode });
                    log.ok('[동줍 자동] 큐 시작');
                    json(res, { success: true, auto: true });
                } else {
                    if (state.farmRunning) { json(res, { success: false, error: '이미 실행 중' }); return; }
                    state.farmRunning = true;
                    const { results, grandTotal } = await farmAllVillages(
                        state.cdp, state.botSessionId, baseUrl,
                        targetVillages, { mode }
                    );
                    state.farmRunning = false;
                    json(res, { success: true, results, grandTotal });
                }
            } catch (e) {
                state.farmRunning = false;
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/farm/auto-stop
        if (pathname === '/api/farm/auto-stop' && req.method === 'POST') {
            if (state.farmQueue) { state.farmQueue.stop(); state.farmQueue = null; }
            persist.setKey(state.server, 'farm', null);
            log.ok('[동줍 자동] 중지');
            json(res, { success: true });
            return;
        }

        // GET /api/farm/status
        if (pathname === '/api/farm/status' && req.method === 'GET') {
            json(res, state.farmQueue ? state.farmQueue.status() : { running: false, stopped: true });
            return;
        }

        // ===== 자동 건설 API =====
        // GET /api/build/priorities — 저장된 우선순위 조회
        if (pathname === '/api/build/priorities' && req.method === 'GET') {
            json(res, { priorities: state.buildPriorities });
            return;
        }

        // POST /api/build/priorities — 저장 (body: { villageId, priority: [{building, target}, ...] })
        if (pathname === '/api/build/priorities' && req.method === 'POST') {
            try {
                const body = JSON.parse(await readBody(req));
                const vid = body.villageId;
                const priority = body.priority || [];
                if (!vid) { json(res, { success: false, error: 'villageId 필요' }); return; }
                state.buildPriorities[vid] = priority;
                persist.setKey(state.server, 'buildPriorities', state.buildPriorities);
                // 큐가 실행 중이면 반영
                if (state.buildQueue) {
                    const v = state.villages.find(vv => vv.id === vid);
                    if (v) state.buildQueue.setVillagePriority(vid, v.name, priority);
                }
                json(res, { success: true });
            } catch (e) { json(res, { success: false, error: e.message }); }
            return;
        }

        // POST /api/build/start — 자동 건설 시작 (body: { villageIds?: [] })
        if (pathname === '/api/build/start' && req.method === 'POST') {
            const baseUrl = `https://${state.server}.tribalwars.net`;
            try {
                const body = JSON.parse(await readBody(req));
                const selected = body.villageIds || Object.keys(state.buildPriorities).map(Number);
                if (state.buildQueue) state.buildQueue.stop();
                state.buildQueue = new BuildingQueue(
                    state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection
                );
                for (const vid of selected) {
                    const priority = state.buildPriorities[vid];
                    if (!priority || priority.length === 0) continue;
                    const v = state.villages.find(vv => vv.id === vid);
                    if (v) state.buildQueue.setVillagePriority(vid, v.name, priority);
                }
                await state.buildQueue.start();
                persist.setKey(state.server, 'build', { villageIds: selected });
                log.ok(`[자동 건설] 시작 — ${selected.length}개 마을`);
                json(res, { success: true });
            } catch (e) { json(res, { success: false, error: e.message }); }
            return;
        }

        // POST /api/build/stop
        if (pathname === '/api/build/stop' && req.method === 'POST') {
            if (state.buildQueue) { state.buildQueue.stop(); state.buildQueue = null; }
            persist.setKey(state.server, 'build', null);
            json(res, { success: true });
            return;
        }

        // ===== 자동 양성 API =====
        // POST /api/trainer/start — body: { villageIds, plan }
        if (pathname === '/api/trainer/start' && req.method === 'POST') {
            const baseUrl = `https://${state.server}.tribalwars.net`;
            try {
                const body = JSON.parse(await readBody(req));
                const ids = body.villageIds || state.villages.map(v => v.id);
                const plan = body.plan || state.trainPlan || DEFAULT_TRAIN_PLAN;
                state.trainPlan = plan;
                const target = state.villages.filter(v => ids.includes(v.id));
                if (state.trainerQueue) state.trainerQueue.stop();
                state.trainerQueue = new TrainerQueue(
                    state.cdp, state.botSessionId, baseUrl,
                    state.scheduler, state.botLock, handleBotProtection
                );
                await state.trainerQueue.start(target, plan);
                persist.setKey(state.server, 'trainer', { villageIds: ids, plan });
                log.ok(`[양성 자동] 시작 — ${target.length}개 마을`);
                json(res, { success: true });
            } catch (e) { json(res, { success: false, error: e.message }); }
            return;
        }
        if (pathname === '/api/trainer/stop' && req.method === 'POST') {
            if (state.trainerQueue) { state.trainerQueue.stop(); state.trainerQueue = null; }
            persist.setKey(state.server, 'trainer', null);
            json(res, { success: true });
            return;
        }
        if (pathname === '/api/trainer/status' && req.method === 'GET') {
            json(res, state.trainerQueue ? state.trainerQueue.status() : { running: false, stopped: true, plan: state.trainPlan || DEFAULT_TRAIN_PLAN });
            return;
        }

        // GET /api/build/status
        if (pathname === '/api/build/status' && req.method === 'GET') {
            json(res, state.buildQueue ? state.buildQueue.status() : { running: false, stopped: true, villages: [] });
            return;
        }

        // POST /api/change-server — 서버 선택 화면으로 돌아가기
        if (pathname === '/api/change-server' && req.method === 'POST') {
            try {
                await cleanupForSwitch();
                // 유저 탭을 월드선택 페이지로 이동
                await navigate(state.cdp, state.sessionId, 'https://www.tribalwars.net/en-dk/');
                await waitForLoad(state.cdp, state.sessionId);
                await sleep(2000);
                // 서버 목록 재감지
                const result = await loginAndDetectServers(state.cdp, state.sessionId, '', '');
                if (result.success) {
                    state.servers = result.servers;
                    state.server = null;
                    state.villages = [];
                    state.phase = 'select_server';
                    json(res, { success: true, servers: result.servers });
                } else {
                    state.phase = 'setup';
                    json(res, { success: false, error: result.error || '서버 목록 감지 실패' });
                }
            } catch (e) {
                log.err('[서버변경] 실패: ' + e.message);
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // POST /api/logout
        if (pathname === '/api/logout' && req.method === 'POST') {
            try {
                await cleanupForSwitch();
                await navigate(state.cdp, state.sessionId, 'https://www.tribalwars.net/en-dk/page/logout');
                await waitForLoad(state.cdp, state.sessionId);
                await sleep(1500);
                state.server = null; state.servers = []; state.villages = [];
                state.phase = 'setup';
                json(res, { success: true });
            } catch (e) {
                log.err('[로그아웃] 실패: ' + e.message);
                json(res, { success: false, error: e.message });
            }
            return;
        }

        // GET /api/bot-protection
        if (pathname === '/api/bot-protection' && req.method === 'GET') {
            json(res, { active: !!state.botProtection, detail: state.botProtection });
            return;
        }

        // POST /api/bot-protection/clear — 유저가 해결 후 해제
        if (pathname === '/api/bot-protection/clear' && req.method === 'POST') {
            clearBotProtection();
            json(res, { success: true });
            return;
        }

        // GET /api/status
        if (pathname === '/api/status' && req.method === 'GET') {
            json(res, {
                phase: state.phase,
                server: state.server,
                villageCount: state.villages.length,
                scheduledCount: state.scheduler?.attacks.filter(a => a.status === 'waiting').length || 0,
            });
            return;
        }

        // ---- 정적 파일 ----
        let filePath;
        if (pathname === '/' || pathname === '/index.html') {
            filePath = path.join(publicDir, 'index.html');
        } else {
            filePath = path.join(publicDir, pathname);
            if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
        }
        try {
            const content = fs.readFileSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
            res.writeHead(200, { 'Content-Type': (mime[ext] || 'text/plain') + '; charset=utf-8' });
            res.end(content);
        } catch { res.writeHead(404); res.end('Not Found'); }
    });

    // 0.0.0.0 바인딩 — 외부 네트워크에서 접근 가능 (포트포워딩용)
    server.listen(args.port, '0.0.0.0', () => {
        log.ok(`웹 서버 시작: http://localhost:${args.port} (모든 네트워크 인터페이스)`);
        // 접근 가능한 로컬 IP 표시
        try {
            const os = require('os');
            const ifaces = os.networkInterfaces();
            const ips = [];
            for (const name of Object.keys(ifaces)) {
                for (const ni of ifaces[name]) {
                    if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
                }
            }
            if (ips.length) {
                log.ok(`  로컬 네트워크: ${ips.map(ip => `http://${ip}:${args.port}`).join(', ')}`);
                log.info(`  외부 접속: 공유기에서 ${args.port} 포트포워딩 → 위 PC IP로 설정 후 공인IP:${args.port}`);
            }
        } catch {}
    });
}

// 간단한 인증 미들웨어 — 환경변수 BUJOK_TOKEN 설정 시 활성화
// 사용법: 헤더 'X-Auth-Token: <토큰>' 또는 쿠키 'bujok_token=<토큰>' 또는 쿼리 ?token=<토큰>
function checkAuth(req) {
    const required = process.env.BUJOK_TOKEN;
    if (!required) return true; // 토큰 미설정 시 인증 안 함
    const headerToken = req.headers['x-auth-token'];
    if (headerToken === required) return true;
    const cookieMatch = (req.headers.cookie || '').match(/bujok_token=([^;]+)/);
    if (cookieMatch && cookieMatch[1] === required) return true;
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') === required) return true;
    return false;
}

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
function readBody(req) {
    return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}

// ==========================================
// 서버 변경/로그아웃 전 안전하게 정리
// 1. 큐/스케줄러 정지 플래그 → 2. 현재 진행 중 작업 끝날 때까지 대기 → 3. 봇 탭 닫기
// ==========================================
async function cleanupForSwitch() {
    log.info('[정리] 큐/스케줄러 정지 신호...');
    state.scheduler?.stop();
    state.scavQueue?.stop();
    state.marketQueue?.stop();
    state.farmQueue?.stop();
    state.buildQueue?.stop();
    state.trainerQueue?.stop();
    state.reportCollector?.stop();
    state.reportCollector = null;

    // 진행 중 작업이 있으면 끝날 때까지 대기 (최대 30초)
    const waitStart = Date.now();
    while (Date.now() - waitStart < 30000) {
        const scavRunning = state.scavQueue?.running;
        const mktRunning = state.marketQueue?.running;
        const schExec = state.scheduler?.executing;
        if (!scavRunning && !mktRunning && !schExec) break;
        log.info(`[정리] 작업 대기 중 (scav=${!!scavRunning}, mkt=${!!mktRunning}, sch=${!!schExec})`);
        await sleep(1000);
    }

    // 락이 아직 잡혀 있으면 해제 시도 (강제)
    if (state.botLock && state.botLock.isHeld()) {
        const h = state.botLock.heldBy();
        log.warn(`[정리] 락 강제 해제: ${h}`);
        state.botLock.release(h);
    }

    // 참조 해제
    state.scavQueue = null;
    state.marketQueue = null;
    state.scheduler = null;

    // 봇 탭 닫기
    if (state.botTargetId) {
        try {
            await state.cdp.closeTab(state.botTargetId);
            log.info('[정리] 봇 탭 닫음');
        } catch {}
        state.botSessionId = null;
        state.botTargetId = null;
    }
}

// ==========================================
// 캡처 프로세스 자동 실행 — 모든 트래픽을 samples/에 계속 저장
// ==========================================
let captureProc = null;
function startCaptureProcess() {
    if (captureProc) return;
    const { spawn } = require('child_process');
    const captureScript = path.join(__dirname, 'capture-samples.js');
    if (!fs.existsSync(captureScript)) {
        log.warn('[캡처] capture-samples.js 없음 — 스킵');
        return;
    }
    // 서버명이 정해진 후에 시작 (state.server가 있으면 필터, 없으면 전체)
    const serverArgs = state.server ? ['--server', state.server] : [];
    captureProc = spawn(process.execPath, [captureScript, ...serverArgs], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    captureProc.stdout.on('data', d => {
        const text = d.toString().trim();
        // 캡처 로그는 너무 많으니 핵심만 (저장 카운트 등)
        if (text.includes('저장') || text.includes('===') || text.includes('탭 부착')) {
            // 짧게
            const summary = text.split('\n').slice(-3).join(' | ');
            if (summary.length > 5) log.debug(`[캡처] ${summary.slice(0, 200)}`);
        }
    });
    captureProc.on('exit', code => {
        log.info(`[캡처] 프로세스 종료 (code=${code})`);
        captureProc = null;
    });
    log.ok(`[캡처] 자동 시작 — samples/ 폴더에 저장${state.server ? ' (서버: ' + state.server + ')' : ''}`);
}

function stopCaptureProcess() {
    if (!captureProc) return;
    try { captureProc.kill('SIGINT'); } catch {}
    captureProc = null;
}

// 서버명 변경 시 캡처 프로세스 재시작 (필터 갱신)
function restartCaptureForServer() {
    stopCaptureProcess();
    setTimeout(() => startCaptureProcess(), 1500);
}

// ==========================================
// 자동 연결 — 기존 Chrome이 디버그 모드로 실행 중이면 바로 연결
// ==========================================
async function tryAutoConnect() {
    try {
        let cdp = new CDP('127.0.0.1', args.cdpPort);
        try {
            await cdp.connect();
        } catch (connErr) {
            // Chrome이 안 켜져 있거나 디버그 모드 아님 → 자동 실행 시도
            log.info(`[자동연결] CDP 연결 실패 — Chrome 디버그 모드 자동 실행 시도`);
            try {
                launchChrome(args.cdpPort);
                await waitForCDP('127.0.0.1', args.cdpPort, 15000);
                cdp = new CDP('127.0.0.1', args.cdpPort);
                await cdp.connect();
                log.ok('[자동연결] Chrome 디버그 모드 자동 실행 성공 — 사용자 수동 로그인 필요');
            } catch (launchErr) {
                throw new Error(`Chrome 자동 실행 실패: ${launchErr.message}`);
            }
        }
        state.cdp = cdp;

        // tribalwars 탭 찾기 (게임 서버 탭 우선)
        const tabs = await cdp.listTabs();
        const gameTab = tabs.find(t => t.type === 'page' &&
            t.url.match(/https:\/\/[a-z0-9]+\.tribalwars\.net\/game\.php/));
        const wwwTab = tabs.find(t => t.type === 'page' && t.url.includes('tribalwars.net'));
        const twTab = gameTab || wwwTab;

        if (!twTab) {
            log.info('[자동연결] Chrome 연결됨, tribalwars 탭 없음 → 로그인 필요');
            return;
        }

        // 탭에 부착
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: twTab.id, flatten: true });
        state.sessionId = sessionId;
        state.targetId = twTab.id;
        await cdp.send('Page.enable', {}, sessionId).catch(() => {});
        await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
        await enableAutoAttachOn(sessionId);

        // 이미 게임 서버에 접속해 있으면 → 바로 서버 선택 완료 상태로
        if (gameTab) {
            const urlMatch = gameTab.url.match(/https:\/\/([a-z0-9]+)\.tribalwars\.net/);
            const serverName = urlMatch ? urlMatch[1] : null;
            if (serverName) {
                log.ok(`[자동연결] 게임 서버 접속 중: ${serverName} → 자동 이어서 진행`);
                const ok = await autoSelectExistingServer(serverName);
                if (ok) return;
            }
        }

        // 로그인 상태 확인 + 서버 감지
        const result = await loginAndDetectServers(cdp, sessionId, '', '');
        if (result.success) {
            state.servers = result.servers;
            state.phase = 'select_server';
            log.ok(`[자동연결] 이미 로그인됨 → 서버 ${result.servers.length}개 감지`);
        } else {
            log.info('[자동연결] 로그인 안 됨 → 로그인 필요');
        }
    } catch (e) {
        log.info('[자동연결] Chrome 미실행 또는 디버그 모드 아님: ' + e.message);
    }
}

// 이미 게임 서버에 접속된 경우 → 봇 탭 생성 + 마을 감지 → ready
async function autoSelectExistingServer(serverName) {
    state.phase = 'entering';
    state.server = serverName;
    restartCaptureForServer();
    const baseUrl = `https://${serverName}.tribalwars.net`;

    try {
        // 봇 전용 탭 생성
        log.info('[자동연결] 봇 탭 생성...');
        const playUrl = `https://www.tribalwars.net/en-dk/page/play/${serverName}`;
        const botTab = await state.cdp.createTab(playUrl);
        state.botSessionId = botTab.sessionId;
        state.botTargetId = botTab.targetId;
        await state.cdp.send('Page.enable', {}, state.botSessionId).catch(() => {});
        await state.cdp.send('Runtime.enable', {}, state.botSessionId).catch(() => {});
        await enableAutoAttachOn(state.botSessionId);

        let botReady = false;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            try {
                const url = await evaluate(state.cdp, state.botSessionId, 'location.href');
                const hasMenu = await evaluate(state.cdp, state.botSessionId,
                    '!!document.querySelector("#menu_row, #menu_row2")');
                if (url.includes('game.php') && hasMenu) { botReady = true; break; }
            } catch {}
        }
        if (!botReady) throw new Error('봇 탭 접속 실패');

        state.phase = 'detecting';
        state.villages = await detectVillages(state.cdp, state.botSessionId, baseUrl);
        log.ok(`[자동연결] 마을 ${state.villages.length}개 감지`);

        state.scheduler = new Scheduler(state.cdp, state.botSessionId, baseUrl);
        state.scheduler.start();
        state.phase = 'ready';
        log.ok(`[자동연결] ${serverName} 준비 완료 — 이어서 진행 가능`);
        startReportCollector(serverName, baseUrl);
        await restoreQueues();
        return true;
    } catch (e) {
        log.warn(`[자동연결] 자동 이어가기 실패: ${e.message}`);
        state.phase = 'setup';
        if (state.botTargetId) {
            await state.cdp.closeTab(state.botTargetId).catch(() => {});
            state.botSessionId = null;
            state.botTargetId = null;
        }
        return false;
    }
}

// ==========================================
// 메인
// ==========================================
async function main() {
    log.info('============================================');
    log.info(' bujok-new v0.1');
    log.info(` 포트: ${args.port}`);
    log.info(' http://localhost:' + args.port + ' 에서 시작하세요');
    log.info('============================================');

    startServer();

    // 서버 시작 시 기존 Chrome(디버그 모드)에 자동 연결 시도
    // 이미 로그인된 상태면 바로 서버 선택으로 넘어감
    tryAutoConnect();

    // 캡처 자동 시작 — 별도 프로세스로 spawn (서버 종료 시 자동 정리)
    startCaptureProcess();

    process.on('SIGINT', async () => {
        log.warn('종료 중...');
        state.scheduler?.stop();
        state.scavQueue?.stop();
        state.marketQueue?.stop();
        state.farmQueue?.stop();
    state.buildQueue?.stop();
    state.trainerQueue?.stop();
    stopCaptureProcess();
        // 봇 탭만 닫음 (유저 탭은 유지 — 유저가 계속 플레이 가능)
        // 봇 탭만 닫음 (유저 탭은 유지)
        try { await state.cdp?.closeTab(state.botTargetId); } catch {}
        try { state.cdp?.close(); } catch {}
        process.exit(0);
    });
}

main();
