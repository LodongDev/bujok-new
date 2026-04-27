// 동줍 메인 모듈 — 마을 자동 감지 + Farm Assistant 클릭 루프
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, waitForSelector, scrollIntoView, checkSessionAlive, sleep } = require('./page');
const { moveAndClick, hover } = require('./mouse');
const { HumanState, nextCadenceMs, randInt } = require('./human');
const log = require('./log');

// 마을 자동 감지 — overview_villages&mode=combined 페이지에서
// 캡처 확인:
//   GET /game.php?village={id}&screen=overview_villages&mode=combined
//   응답 HTML의 <table id="combined_table"> 안에:
//     <span class="quickedit-vn" data-id="96406">
//       <span class="quickedit-label" data-text="Noble 001">Noble 001 (184|485) K41</span>
//     </span>
//   - data-id: 마을 ID
//   - data-text: 마을 이름
//   - 텍스트에서 (x|y) 좌표 추출
async function detectVillages(cdp, sessionId, baseUrl) {
    log.info('마을 목록 자동 감지 중...');

    // group=0 (전체 그룹) — 특정 그룹이 기본값으로 설정돼 있어도 전부 보이게
    const url = `${baseUrl}/game.php?screen=overview_villages&mode=combined&group=0`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(800, 1500));

    // 봇 프로텍션 체크 — 캡차 떠있으면 특별 에러로 던짐 (탭 유지)
    const { checkBotProtection } = require('./bot-protection');
    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) {
        const err = new Error(`봇 프로텍션 감지: ${protection.type}`);
        err.botProtection = protection;
        throw err;
    }

    if (!await checkSessionAlive(cdp, sessionId)) {
        throw new Error('세션 만료 또는 로그인 안 됨');
    }

    const villages = await evaluate(cdp, sessionId, `
        (() => {
            try {
                const table = document.getElementById('combined_table');
                if (!table) return { error: 'combined_table 못 찾음' };

                const result = [];
                // quickedit-vn 요소에서 마을 정보 추출
                const spans = table.querySelectorAll('span.quickedit-vn[data-id]');
                for (const span of spans) {
                    const id = parseInt(span.getAttribute('data-id'));
                    if (!id) continue;
                    const label = span.querySelector('.quickedit-label');
                    const name = label ? label.getAttribute('data-text') : '';
                    const text = label ? label.textContent.trim() : '';
                    // 텍스트에서 좌표 추출: "Noble 001 (184|485) K41"
                    const coordM = text.match(/\\((\\d+)\\|(\\d+)\\)/);
                    result.push({
                        id,
                        name: name || '',
                        x: coordM ? parseInt(coordM[1]) : null,
                        y: coordM ? parseInt(coordM[2]) : null,
                    });
                }
                return result;
            } catch (e) {
                return { error: e.message };
            }
        })()
    `);

    if (villages?.error || !villages || villages.length === 0) {
        // 실패 시 전체 DOM 덤프 저장 (분석용)
        const dump = await evaluate(cdp, sessionId, `
            (() => {
                const info = {
                    url: location.href,
                    title: document.title,
                    ts: new Date().toISOString(),
                    bodyText: (document.body?.innerText || '').slice(0, 2000),
                    bodyClasses: document.body?.className || '',
                };
                info.iframes = [...document.querySelectorAll('iframe')].map(f => {
                    const r = f.getBoundingClientRect();
                    return { src: f.src, id: f.id, name: f.name, x: r.x, y: r.y, w: r.width, h: r.height, visible: f.offsetParent !== null };
                });
                info.topLevelElements = [...document.body?.children || []].slice(0, 20).map(el => ({
                    tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0, 100), childCount: el.children.length,
                }));
                info.anySuspicious = [...document.querySelectorAll('[id*="botcheck"],[id*="captcha"],[class*="captcha"],[class*="challenge"],[class*="hcaptcha"],[data-sitekey]')].slice(0, 10).map(el => {
                    const r = el.getBoundingClientRect();
                    return { tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0,150), x: r.x, y: r.y, w: r.width, h: r.height, sitekey: el.getAttribute('data-sitekey') };
                });
                info.fullHtml = document.documentElement.outerHTML.slice(0, 10000);
                return info;
            })()
        `);

        // 파일로 저장
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', 'captchas');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        const file = path.join(dir, `detect-fail-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(dump, null, 2));
        log.warn(`[감지 실패] DOM 덤프 저장: captchas/${path.basename(file)}`);
        log.warn('[감지 실패] URL: ' + dump.url);
        log.warn('[감지 실패] title: ' + dump.title);
        if (dump.iframes?.length > 0) log.warn('[감지 실패] iframes: ' + dump.iframes.length + '개');
        if (dump.anySuspicious?.length > 0) log.warn('[감지 실패] suspicious 요소: ' + dump.anySuspicious.length + '개');

        // 캡차 흔적 있으면 봇 프로텍션으로 (탭 유지)
        const hasCaptchaSign = dump.anySuspicious?.length > 0
            || dump.iframes?.some(f => f.src?.includes('hcaptcha') || f.src?.includes('recaptcha'))
            || /botcheck|captcha|verify|robot/i.test(dump.bodyText || '')
            || /botcheck|captcha|verify/i.test(dump.url || '');
        if (hasCaptchaSign) {
            const err = new Error('봇체크/캡차 페이지');
            err.botProtection = { type: 'detected_in_detectVillages', dumpFile: file };
            throw err;
        }

        throw new Error('마을 감지 실패 (URL: ' + dump.url + ', 덤프: captchas/' + path.basename(file) + ')');
    }

    log.ok(`마을 ${villages.length}개 감지됨`);
    for (const v of villages) {
        const coord = (v.x && v.y) ? `(${v.x}|${v.y})` : '';
        log.info(`  • ${v.id} ${v.name} ${coord}`);
    }
    return villages;
}

// Farm Assistant 페이지로 이동
async function gotoFarmAssistant(cdp, sessionId, baseUrl, villageId) {
    const url = `${baseUrl}/game.php?village=${villageId}&screen=am_farm`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(400, 1000));
}

// 현재 페이지의 동줍 가능한 row 추출 (A 버튼 좌표)
async function extractFarmRows(cdp, sessionId) {
    return await evaluate(cdp, sessionId, `
        (() => {
            const result = [];
            // tr id="village_TARGETID" 패턴
            const trs = document.querySelectorAll('tr[id^="village_"]');
            for (const tr of trs) {
                const m = tr.id.match(/village_(\\d+)/);
                if (!m) continue;
                const targetId = parseInt(m[1]);
                // 데코레이션 아닌 진짜 farm A 버튼
                const btnA = tr.querySelector('a.farm_icon_a:not(.decoration)');
                if (!btnA) continue;
                const r = btnA.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                result.push({
                    targetId,
                    x: r.x + r.width / 2,
                    y: r.y + r.height / 2,
                });
            }
            return result;
        })()
    `);
}

// row가 viewport 안에 보이도록 스크롤
async function scrollRowIntoView(cdp, sessionId, targetId) {
    await evaluate(cdp, sessionId, `
        (() => {
            const el = document.getElementById('village_${targetId}');
            if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
        })()
    `);
    await sleep(100); // 스크롤 안정화
}

// 위장 행동 — 가끔 게임 다른 부분 보기 (마우스만 움직이거나 호버)
async function distract(cdp, sessionId, lastPos) {
    const choice = Math.random();

    if (choice < 0.4) {
        // 1. 임의 위치로 마우스 이동 (호버)
        const x = randInt(150, 1100);
        const y = randInt(80, 600);
        log.human(`위장: hover (${x}, ${y})`);
        await hover(cdp, sessionId, lastPos, { x, y });
        return { x, y };
    } else if (choice < 0.7) {
        // 2. 페이지 스크롤
        const dy = randInt(-300, 300);
        log.human(`위장: scroll ${dy > 0 ? '+' : ''}${dy}`);
        await evaluate(cdp, sessionId, `window.scrollBy({ top: ${dy}, behavior: 'instant' })`);
        await sleep(randInt(200, 800));
        return lastPos;
    } else {
        // 3. 짧게 그냥 정지 ("주의 분산")
        const ms = randInt(1500, 4000);
        log.human(`위장: idle ${ms}ms`);
        await sleep(ms);
        return lastPos;
    }
}

// 한 마을의 동줍 처리 (단일 페이지)
async function farmVillageOnce(cdp, sessionId, baseUrl, village, human, state) {
    log.info(`[${village.name || village.id}] Farm Assistant 진입`);

    await gotoFarmAssistant(cdp, sessionId, baseUrl, village.id);

    // 페이지 로드 후 row가 채워질 때까지 대기 (page_entries AJAX가 자동 호출됨)
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt++) {
        rows = await extractFarmRows(cdp, sessionId);
        if (rows.length > 0) break;
        await sleep(300);
    }

    if (rows.length === 0) {
        log.warn(`[${village.id}] 동줍 가능한 마을 없음`);
        return 0;
    }

    log.ok(`[${village.id}] ${rows.length}개 row 발견`);

    let farmed = 0;
    for (const row of rows) {
        if (state.stopping) break;

        try {
            // 세션 체크 (가끔)
            if (farmed > 0 && farmed % 15 === 0) {
                if (!await checkSessionAlive(cdp, sessionId)) {
                    log.err('세션 만료 감지 → 중단');
                    state.stopping = true;
                    break;
                }
            }

            // row가 viewport에 안 보일 수 있으니 스크롤
            await scrollRowIntoView(cdp, sessionId, row.targetId);

            // 스크롤 후 좌표 다시 추출
            const updatedRect = await evaluate(cdp, sessionId, `
                (() => {
                    const el = document.getElementById('village_${row.targetId}');
                    if (!el) return null;
                    const btn = el.querySelector('a.farm_icon_a:not(.decoration)');
                    if (!btn) return null;
                    const r = btn.getBoundingClientRect();
                    if (r.width === 0) return null;
                    return { x: r.x + r.width/2, y: r.y + r.height/2 };
                })()
            `);

            if (!updatedRect) {
                log.debug(`row ${row.targetId} 사라짐 → 스킵`);
                continue;
            }

            // 마우스 이동 + 클릭
            await moveAndClick(cdp, sessionId, state.lastMouse, updatedRect);
            state.lastMouse = updatedRect;
            farmed++;
            log.ok(`[${village.id}] 동줍 #${state.totalFarmed + farmed} → target ${row.targetId}`);

            // 인간 케이던스
            const next = human.afterAction();
            if (next.type === 'break') {
                log.human(`★ 휴식 ${Math.round(next.ms/1000)}초 (총 ${human.actions}회 동줍 후)`);
                await sleep(next.ms);
                log.human('★ 휴식 종료, 재개');
            } else if (next.type === 'long') {
                log.human(`긴 정지 ${Math.round(next.ms/1000)}초`);
                await sleep(next.ms);
            } else if (next.type === 'short') {
                log.human(`짧은 정지 ${Math.round(next.ms)}ms`);
                await sleep(next.ms);
            } else {
                await sleep(next.ms);
            }

            // 위장 행동 가끔
            if (human.shouldDistract()) {
                state.lastMouse = await distract(cdp, sessionId, state.lastMouse);
            }
        } catch (e) {
            log.err(`동줍 실패 (${row.targetId}): ${e.message}`);
            await sleep(2000);
        }
    }

    log.ok(`[${village.id}] 페이지 완료: ${farmed}건`);
    return farmed;
}

module.exports = { detectVillages, farmVillageOnce };
