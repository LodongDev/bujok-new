// 자동 동줍 — 캡처 기반 정확 구현
// 캡처 확인:
//   GET  /game.php?village={src}&screen=am_farm
//     → HTML에서 farm_icon_a/b/c 버튼 + village row + template_id 파싱
//   POST /game.php?village={src}&screen=am_farm&mode=farm&ajaxaction=farm&json=1
//     Body: target={target_id}&template_id={A=325|B=..}&source={src}&h={csrf}
//     Headers: TribalWars-Ajax: 1, X-Requested-With: XMLHttpRequest
//   응답: { response: { success: "Sent: ...", current_units: {...} } }
//        실패 시: { error: [ "..." ] }

const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { randInt } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

class BotProtectionError extends Error {
    constructor(detail) { super(`봇 프로텍션: ${detail.type}`); this.detail = detail; }
}

// Farm Assistant 페이지 데이터 파싱
// 반환: { rows: [{targetId, hasA, hasB}], templateIdA, templateIdB, csrf }
// order: 'distance' | 'date' | 'wall' (캡처 확인된 값)
// date = 마지막 약탈 시각 (asc면 오래된 마을 우선)
// 정렬 기본값을 'distance'로 변경 — 가까운 마을 먼저 처리 → 더 자주 가능 → 다른 플레이어보다 먼저 채감
// 캡처 검증된 order 값: 'distance' | 'date' | 'wall'
async function loadFarmPage(cdp, sessionId, baseUrl, sourceVillageId, page = 1, order = 'distance') {
    const url = `${baseUrl}/game.php?village=${sourceVillageId}&screen=am_farm&order=${order}&dir=asc&Farm_page=${page}`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(500, 1000));

    // 봇 프로텍션 체크
    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) throw new BotProtectionError(protection);

    // "Show only attacks that were sent from this village" 체크박스 항상 ON 유지
    // 캡처 검증된 toggleAllVillages() 함수 호출 — 페이지가 자체 POST로 처리
    try {
        const toggled = await evaluate(cdp, sessionId, `
            (() => {
                const cb = document.getElementById('all_village_checkbox');
                if (cb && !cb.checked) { cb.click(); return true; }
                return false;
            })()
        `).catch(() => false);
        if (toggled) {
            log.info(`[동줍] ${sourceVillageId} — "이 마을 공격만 표시" 체크박스 ON`);
            await sleep(randInt(800, 1500));  // 페이지 갱신 대기
            // 페이지 다시 로드 (필터 적용된 row 보이게)
            await navigate(cdp, sessionId, url);
            await waitForLoad(cdp, sessionId);
            await sleep(randInt(400, 800));
        }
    } catch (e) { /* 무시 */ }

    return await evaluate(cdp, sessionId, `
        (() => {
            try {
                // CSRF
                let csrf = null;
                if (typeof TribalWars !== 'undefined' && TribalWars.getGameData) {
                    csrf = TribalWars.getGameData().csrf;
                }
                if (!csrf) {
                    const m = document.documentElement.innerHTML.match(/&h=([a-f0-9]+)/);
                    if (m) csrf = m[1];
                }

                // 보유 병력 — units_home 테이블에서 추출 (캡처 검증: td.unit-item[data-unit-count])
                const availableUnits = {};
                document.querySelectorAll('td.unit-item[data-unit-count]').forEach(td => {
                    const unit = td.id;
                    const count = parseInt(td.getAttribute('data-unit-count')) || 0;
                    if (unit) availableUnits[unit] = count;
                });

                // title에서 필요 병력 추출 (캡처 검증: <img src=".../unit_X.webp"/>N)
                // jQuery tooltip이 title을 다른 속성으로 옮길 수 있어 여러 곳에서 시도
                const getTitleHtml = (el) => {
                    if (!el) return '';
                    return el.getAttribute('title')
                        || el.getAttribute('data-original-title')
                        || el.getAttribute('data-title')
                        || el.getAttribute('data-tooltip-content')
                        || '';
                };
                const parseRequiredUnits = (titleHtml) => {
                    if (!titleHtml) return null;
                    const req = {};
                    // 디코딩된 HTML (><img>N) — getAttribute는 보통 디코딩됨
                    const re1 = /unit_(\\w+)\\.webp[^>]*\\/?>\\s*(\\d+)/g;
                    let m;
                    while ((m = re1.exec(titleHtml)) !== null) {
                        req[m[1]] = parseInt(m[2]);
                    }
                    // 인코딩된 채로 들어온 경우 (&gt; 형태)
                    if (Object.keys(req).length === 0) {
                        const re2 = /unit_(\\w+)\\.webp[^&]*&gt;\\s*(\\d+)/g;
                        while ((m = re2.exec(titleHtml)) !== null) {
                            req[m[1]] = parseInt(m[2]);
                        }
                    }
                    return Object.keys(req).length ? req : null;
                };

                const rows = [];
                let tplA = null, tplB = null;
                const trs = document.querySelectorAll('tr[id^="village_"]');
                for (const tr of trs) {
                    const m = tr.id.match(/village_(\\d+)/);
                    if (!m) continue;
                    const targetId = parseInt(m[1]);
                    const btnA = tr.querySelector('a.farm_icon_a:not(.decoration)');
                    const btnB = tr.querySelector('a.farm_icon_b:not(.decoration)');
                    const btnC = tr.querySelector('a.farm_icon_c:not(.decoration)');

                    let aTpl = null, bTpl = null, reportId = null;
                    let durSec = null;
                    let reqA = null, reqB = null;

                    if (btnA) {
                        const oc = btnA.getAttribute('onclick') || '';
                        const am = oc.match(/sendUnits\\([^,]+,\\s*\\d+,\\s*(\\d+)/);
                        if (am) { aTpl = parseInt(am[1]); if (!tplA) tplA = aTpl; }
                        const tt = getTitleHtml(btnA);
                        reqA = parseRequiredUnits(tt);
                        const dm = tt.match(/Duration:\\s*(\\d+):(\\d{1,2}):(\\d{1,2})/);
                        if (dm) durSec = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseInt(dm[3]);
                    }
                    if (btnB) {
                        const oc = btnB.getAttribute('onclick') || '';
                        const bm = oc.match(/sendUnits\\([^,]+,\\s*\\d+,\\s*(\\d+)/);
                        if (bm) { bTpl = parseInt(bm[1]); if (!tplB) tplB = bTpl; }
                        const tt = getTitleHtml(btnB);
                        reqB = parseRequiredUnits(tt);
                        if (!durSec) {
                            const dm = tt.match(/Duration:\\s*(\\d+):(\\d{1,2}):(\\d{1,2})/);
                            if (dm) durSec = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseInt(dm[3]);
                        }
                    }
                    if (btnC) {
                        const oc = btnC.getAttribute('onclick') || '';
                        const rm = oc.match(/sendUnitsFromReport\\([^,]+,\\s*\\d+,\\s*(\\d+)/);
                        if (rm) reportId = parseInt(rm[1]);
                        if (!durSec) {
                            const tt = getTitleHtml(btnC);
                            const dm = tt.match(/Duration:\\s*(\\d+):(\\d{1,2}):(\\d{1,2})/);
                            if (dm) durSec = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseInt(dm[3]);
                        }
                    }

                    rows.push({
                        targetId,
                        hasA: !!btnA, hasB: !!btnB, hasC: !!btnC,
                        templateIdA: aTpl, templateIdB: bTpl,
                        reportId,
                        durationSec: durSec,
                        requiredA: reqA, requiredB: reqB,
                    });
                }

                const nextBtn = document.querySelector('a[href*="Farm_page="][title*="Next"], .paged-nav-next');
                const hasNext = !!nextBtn && nextBtn.offsetParent !== null;

                return { csrf, tplA, tplB, rows, hasNext, availableUnits };
            } catch (e) { return { error: e.message }; }
        })()
    `);
}

// 한 마을의 overview 페이지에서 "Return from" 복귀 부대 추출
// 캡처 확인: <span class="widget-command-timer" data-endtime="UNIX_SEC">0:16:03</span>
//            data-command-type="return"
// fetch로 overview HTML 받아서 attack+return 명령 모두 추출 (기존에 잘 작동했던 방식)
//   attack: 가는 중 → 복귀시각 = 도착시각 + 남은 거리 시간
//   return: 돌아오는 중 → 복귀시각 = endtime
async function getReturnsForVillage(cdp, sessionId, baseUrl, villageId) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=overview', {
                    headers: { 'TribalWars-Ajax': '1', 'X-Requested-With': 'XMLHttpRequest' },
                });
                const html = await res.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const nowMs = Date.now();
                const returns = [];
                doc.querySelectorAll('span.command_hover_details[data-command-type]').forEach(span => {
                    const type = span.getAttribute('data-command-type');
                    if (type !== 'attack' && type !== 'return') return;
                    const tr = span.closest('tr.command-row');
                    if (!tr) return;
                    const timer = tr.querySelector('span.widget-command-timer[data-endtime]');
                    if (!timer) return;
                    const endtime = parseInt(timer.getAttribute('data-endtime'));
                    if (!endtime) return;
                    const endtimeMs = endtime * 1000;
                    let returnMs;
                    if (type === 'return') {
                        returnMs = endtimeMs;
                    } else {
                        const remain = endtimeMs - nowMs;
                        returnMs = remain > 0 ? endtimeMs + remain : endtimeMs;
                    }
                    const labelEl = tr.querySelector('span.quickedit-label');
                    const label = (labelEl?.textContent || '').trim();
                    returns.push({ type, endtime, endtimeMs: returnMs, label });
                });
                return { ok: true, count: returns.length, returns };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// 여러 마을의 복귀 부대 모두 모아서 가장 빠른 시각 반환
async function getAllReturnsFromOverview(cdp, sessionId, baseUrl, villageIds = []) {
    let earliestMs = null;
    let totalCount = 0;
    let earliestLabel = '';
    let attackCount = 0, returnCount = 0;
    for (const vid of villageIds) {
        const r = await getReturnsForVillage(cdp, sessionId, baseUrl, vid);
        if (!r?.ok) {
            log.warn(`[동줍] 마을 ${vid} overview 실패: ${r?.error || 'unknown'}`);
            continue;
        }
        totalCount += r.count;
        for (const ret of r.returns) {
            if (ret.type === 'attack') attackCount++; else returnCount++;
            if (!earliestMs || ret.endtimeMs < earliestMs) {
                earliestMs = ret.endtimeMs;
                earliestLabel = ret.label;
            }
        }
    }
    log.info(`[동줍] overview 명령: ${attackCount}개 attack + ${returnCount}개 return = ${totalCount}개`);
    return { ok: true, count: totalCount, earliestMs, earliestLabel };
}

// 마을의 outgoing 명령 조회 (이미 출전 중인 부대 + 도착 시간)
// 캡처: POST /game.php?village=X&screen=place&ajax=commands&oscreen=overview
//        Body: type=outgoing&village_id=X&h={csrf}
//        응답.response = HTML (commands_outgoings 컨테이너)
async function getOutgoingCommands(cdp, sessionId, baseUrl, villageId, csrf) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const params = new URLSearchParams();
                params.append('type', 'outgoing');
                params.append('village_id', '${villageId}');
                params.append('h', '${csrf}');
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=place&ajax=commands&oscreen=overview', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                });
                const text = await res.text();
                if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON' };
                const json = JSON.parse(text);
                const html = json.response || '';
                // command-row 안의 data-id (command id), 도착시각 (data-endtime 또는 timer)
                // 간단 파싱: tr 개수 + 각 tr의 timer (남은시간)
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const cmds = [];
                doc.querySelectorAll('tr.command-row').forEach(tr => {
                    const idEl = tr.querySelector('[data-id]');
                    const id = idEl ? idEl.getAttribute('data-id') : null;
                    // 도착까지 남은 시간 표시
                    const timer = tr.querySelector('span.timer');
                    let arrivesInSec = null;
                    if (timer) {
                        const m = timer.textContent.match(/(\\d+):(\\d{1,2}):(\\d{1,2})/);
                        if (m) arrivesInSec = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]);
                    }
                    cmds.push({ id, arrivesInSec });
                });
                return { ok: true, count: cmds.length, commands: cmds };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// A/B 버튼 클릭: template 기반 공격
async function sendFarmTemplate(cdp, sessionId, baseUrl, sourceVillageId, targetId, templateId, csrf) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const params = new URLSearchParams();
                params.append('target', '${targetId}');
                params.append('template_id', '${templateId}');
                params.append('source', '${sourceVillageId}');
                params.append('h', '${csrf}');
                const res = await fetch('${baseUrl}/game.php?village=${sourceVillageId}&screen=am_farm&mode=farm&ajaxaction=farm&json=1', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                });
                const text = await res.text();
                if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON' };
                const json = JSON.parse(text);
                if (json.error) return { ok: false, error: Array.isArray(json.error) ? json.error[0] : json.error };
                return { ok: true, response: json.response };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// C 버튼 클릭: report 기반 자동 병력 공격
// 캡처: POST ?ajaxaction=farm_from_report  Body: report_id=X&h=CSRF
async function sendFarmFromReport(cdp, sessionId, baseUrl, sourceVillageId, reportId, csrf) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const params = new URLSearchParams();
                params.append('report_id', '${reportId}');
                params.append('h', '${csrf}');
                const res = await fetch('${baseUrl}/game.php?village=${sourceVillageId}&screen=am_farm&mode=farm&ajaxaction=farm_from_report&json=1', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                });
                const text = await res.text();
                if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON' };
                const json = JSON.parse(text);
                if (json.error) return { ok: false, error: Array.isArray(json.error) ? json.error[0] : json.error };
                return { ok: true, response: json.response };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// 한 마을의 Farm Assistant 전체 처리 (모든 페이지)
// options:
//   mode: 'C' (기본, 리포트 기반) | 'A' | 'B' | 'C_OR_A' (C 우선, 없으면 A)
//   maxPages
// 딜레이는 사용자 수동 패턴에 맞춤 (캡처 분석 기준):
//   min: 500ms (사용자 최소 480ms보다 살짝 위)
//   max: 2500ms (사용자 75%값 2373ms 근처)
//   10% 확률로 긴 쉼 3~8초 (사용자의 "다른 row 이동/생각" 패턴)
async function farmFromVillage(cdp, sessionId, baseUrl, sourceVillage, options = {}) {
    const mode = options.mode || 'C';
    const maxPages = options.maxPages || 10;
    const delayMin = options.delayMin || 500;
    const delayMax = options.delayMax || 2500;
    const longPauseChance = options.longPauseChance ?? 0.1;
    const longPauseMin = options.longPauseMin || 3000;
    const longPauseMax = options.longPauseMax || 8000;

    let totalSent = 0;
    let totalFailed = 0;
    let lastError = null;
    let earliestReturnMs = null;
    let existingOutCount = 0;

    for (let page = 1; page <= maxPages; page++) {
        let data;
        try {
            data = await loadFarmPage(cdp, sessionId, baseUrl, sourceVillage.id, page);
        } catch (e) {
            if (e instanceof BotProtectionError) throw e;
            lastError = e.message;
            log.warn(`[동줍] ${sourceVillage.name} p${page} 로드 실패: ${e.message}`);
            break;
        }

        if (data?.error) { lastError = data.error; break; }
        if (!data?.csrf) { lastError = 'CSRF 없음'; break; }

        // 각 row별로 어떤 방식으로 공격할지 결정
        // C 모드: hasC 있는 row만 farm_from_report
        // A/B 모드: hasA/hasB 있는 row만 template
        // C_OR_A: hasC면 C, 없으면 hasA면 A
        const actions = [];
        for (const row of data.rows) {
            if (mode === 'C') {
                if (row.hasC && row.reportId) actions.push({ row, method: 'C' });
            } else if (mode === 'A') {
                if (row.hasA) actions.push({ row, method: 'A' });
            } else if (mode === 'B') {
                if (row.hasB) actions.push({ row, method: 'B' });
            } else if (mode === 'C_OR_A') {
                if (row.hasC && row.reportId) actions.push({ row, method: 'C' });
                else if (row.hasA) actions.push({ row, method: 'A' });
            }
        }

        if (actions.length === 0) {
            log.info(`[동줍] ${sourceVillage.name} p${page} — 공격 가능 row 없음 (mode=${mode})`);
            // 첫 페이지에서 0이고 아직 필터 확장 안 했으면 → 체크박스 토글 후 재시도
            // 페이지의 onclick 함수(.click())로 토글 — TW가 알아서 POST 처리, body 추측 회피
            if (page === 1 && !options._filtersExpanded) {
                const toggled = await evaluate(cdp, sessionId, `
                    (() => {
                        const out = { attacked: false, fullLosses: false };
                        const a = document.getElementById('attacked_checkbox');
                        if (a && !a.checked) { a.click(); out.attacked = true; }
                        const f = document.getElementById('full_losses_checkbox');
                        if (f && !f.checked) { f.click(); out.fullLosses = true; }
                        return out;
                    })()
                `).catch(() => null);
                if (toggled && (toggled.attacked || toggled.fullLosses)) {
                    log.info(`[동줍] ${sourceVillage.name} 필터 확장 (attacked:${toggled.attacked}, fullLosses:${toggled.fullLosses}) — 재로드`);
                    await sleep(randInt(1000, 2500));
                    // 페이지 새로 로드 (시간순 정렬 유지: URL의 order=date&dir=asc)
                    return await farmFromVillage(cdp, sessionId, baseUrl, sourceVillage, { ...options, _filtersExpanded: true });
                }
            }
            if (!data.hasNext) break;
            continue;
        }

        // 라운드 간 같은 타겟 반복 공격 방지
        // recentTargets: Map<targetId, { sentAtMs, returnsAtMs }>
        // returnsAtMs = sentAtMs + 2 * durationSec * 1000 + 30s buffer (실제 부대 복귀 시각)
        // 부대가 돌아오기 전에는 그 타겟에 다시 보내지 않음 (자연스럽게 다음 타겟으로 순환)
        const recentTargets = options.recentTargets;
        const fallbackCooldownMs = options.cooldownMs || 10 * 60 * 1000;
        const nowMs = Date.now();
        let cooldownSkipped = 0;
        if (recentTargets) {
            const filtered = [];
            for (const a of actions) {
                const rec = recentTargets.get(a.row.targetId);
                if (rec) {
                    // 객체 형식이면 returnsAtMs 비교, 숫자(과거 형식)면 fallback cooldown
                    const expiry = typeof rec === 'object' ? rec.returnsAtMs : rec + fallbackCooldownMs;
                    if (nowMs < expiry) {
                        cooldownSkipped++;
                        continue;
                    }
                }
                filtered.push(a);
            }
            if (cooldownSkipped > 0) {
                log.info(`[동줍] ${sourceVillage.name} 쿨다운으로 ${cooldownSkipped}개 타겟 스킵 (부대 복귀 전)`);
            }
            actions.splice(0, actions.length, ...filtered);
            if (actions.length === 0) {
                log.info(`[동줍] ${sourceVillage.name} p${page} — 쿨다운 후 남은 row 0개`);
                if (!data.hasNext) break;
                continue;
            }
        }

        // 사전 병력 체크 — 캡처 검증된 데이터 기반
        // 보유 병력(availableUnits)과 각 row의 필요 병력(requiredA/B) 비교 → 가능한 것만 시도
        const available = { ...(data.availableUnits || {}) };
        const canAfford = (req) => {
            if (!req) return true; // 필요량 모르면 시도 (안전망)
            for (const [unit, n] of Object.entries(req)) {
                if ((available[unit] || 0) < n) return false;
            }
            return true;
        };
        const decrement = (req) => {
            if (!req) return;
            for (const [unit, n] of Object.entries(req)) {
                available[unit] = Math.max(0, (available[unit] || 0) - n);
            }
        };

        const cCount = actions.filter(a => a.method === 'C').length;
        // 사전 체크 통계: requiredB 파싱 성공 / 실패
        const reqParsed = actions.filter(a => {
            const r = a.method === 'A' ? a.row.requiredA : a.method === 'B' ? a.row.requiredB : null;
            return r != null;
        }).length;
        log.info(`[동줍] ${sourceVillage.name} p${page} — 활성 row ${actions.length}개 (C:${cCount}, 필요병력파싱:${reqParsed}/${actions.length}) 보유:${JSON.stringify(available)}`);

        let skipped = 0;
        for (const { row, method } of actions) {
            // C는 필요 병력 정보 없음 → 일단 시도 (결과로 판단)
            // A/B는 필요 병력 사전 체크
            const required = method === 'A' ? row.requiredA : (method === 'B' ? row.requiredB : null);
            if (method !== 'C' && !canAfford(required)) {
                skipped++;
                continue;
            }

            let result;
            if (method === 'C') {
                result = await sendFarmFromReport(cdp, sessionId, baseUrl, sourceVillage.id, row.reportId, data.csrf);
            } else {
                const tplId = method === 'A' ? row.templateIdA : row.templateIdB;
                if (!tplId) { totalFailed++; lastError = `${method} 템플릿 없음`; continue; }
                result = await sendFarmTemplate(cdp, sessionId, baseUrl, sourceVillage.id, row.targetId, tplId, data.csrf);
            }

            if (result?.ok) {
                totalSent++;
                decrement(required);
                // 쿨다운 추적 — 부대가 돌아올 때까지는 이 타겟에 다시 안 보냄
                // 캡처 검증: row.durationSec = 편도 시간 (title의 "Duration: H:MM:SS")
                if (recentTargets) {
                    const sentAtMs = Date.now();
                    const roundtripMs = (row.durationSec || 600) * 2 * 1000; // 모르면 20분 가정
                    const buffer = 30000; // 30초 버퍼
                    recentTargets.set(row.targetId, {
                        sentAtMs,
                        returnsAtMs: sentAtMs + roundtripMs + buffer,
                        coords: row.targetId,
                    });
                }
                // 응답의 current_units로 보유 병력 정확히 갱신 (오차 방지)
                const cu = result.response?.current_units;
                if (cu) {
                    for (const [u, v] of Object.entries(cu)) available[u] = parseInt(v) || 0;
                }
                if (row.durationSec) {
                    const returnAt = Date.now() + 2 * row.durationSec * 1000;
                    if (!earliestReturnMs || returnAt < earliestReturnMs) earliestReturnMs = returnAt;
                }
            } else {
                // 병력 부족이면 즉시 마을 종료 (다음 row도 같은 문제)
                const err = (result?.error || '').toLowerCase();
                if (err.includes('not enough') || err.includes('insufficient')) {
                    log.info(`[동줍] ${sourceVillage.name} 병력 부족 — 마을 중단`);
                    return { totalSent, totalFailed: totalFailed + 1, lastError: result.error, earliestReturnMs };
                }
                totalFailed++;
                lastError = result?.error || 'unknown';
                if (lastError.includes('not enough') || lastError.includes('Command queue') ||
                    lastError.includes('limit') || lastError.includes('blocked')) {
                    log.warn(`[동줍] ${sourceVillage.name} 중단: ${lastError}`);
                    return { totalSent, totalFailed, lastError, stopped: true };
                }
            }
            // 딜레이 — 일반 랜덤 + 가끔 긴 쉼
            if (Math.random() < longPauseChance) {
                await sleep(randInt(longPauseMin, longPauseMax));
            } else {
                await sleep(randInt(delayMin, delayMax));
            }
        }

        if (skipped > 0) log.info(`[동줍] ${sourceVillage.name} p${page} — 사전 체크로 ${skipped}개 스킵 (병력 부족 예측)`);
        if (!data.hasNext) break;
        await sleep(randInt(1000, 2000));
    }

    // 추가: place_commands로 이미 outgoing인 부대도 고려 (가장 빠른 도착 + travel)
    // 보낸 게 없으면 이미 출전 중인 부대의 도착 시각도 후보에 포함
    return { totalSent, totalFailed, lastError, earliestReturnMs };
}

// 전체 마을 자동 동줍 — 가장 빠른 복귀 시각 반환
async function farmAllVillages(cdp, sessionId, baseUrl, villages, options = {}) {
    log.info(`[동줍] 전체 ${villages.length}개 마을 시작 (mode=${options.mode || 'C'})`);
    const results = [];
    let grandTotal = 0;
    let earliestReturnMs = null;

    // 각 마을 처리 후 그 마을의 am_farm 페이지에 있는 동안 그 마을의 overview를 fetch
    // (Referer가 같은 마을이라 컨텍스트 일치)
    let totalCmdCount = 0;
    let aggrEarliestMs = null;
    let aggrLabel = '';

    for (let i = 0; i < villages.length; i++) {
        const v = villages[i];
        try {
            const r = await farmFromVillage(cdp, sessionId, baseUrl, v, options);
            results.push({ ...v, ...r });
            grandTotal += r.totalSent;
            if (r.earliestReturnMs && (!earliestReturnMs || r.earliestReturnMs < earliestReturnMs)) {
                earliestReturnMs = r.earliestReturnMs;
            }
            // 실패 0이면 깔끔하게 표시
            const failPart = r.totalFailed > 0 ? ` (실패 ${r.totalFailed}: ${r.lastError || ''})` : '';
            log.ok(`[동줍] ${v.name} — ${r.totalSent}회 전송${failPart}`);

            // 이 마을의 overview를 같은 컨텍스트(am_farm of v)에서 fetch — Referer 일치
            try {
                const ov = await getReturnsForVillage(cdp, sessionId, baseUrl, v.id);
                if (ov?.ok) {
                    totalCmdCount += ov.count;
                    for (const ret of ov.returns) {
                        if (!aggrEarliestMs || ret.endtimeMs < aggrEarliestMs) {
                            aggrEarliestMs = ret.endtimeMs;
                            aggrLabel = ret.label;
                        }
                    }
                }
            } catch (e) { log.warn(`[동줍] ${v.name} overview 조회 실패: ${e.message}`); }

            if (i < villages.length - 1) await sleep(randInt(3000, 6000));
        } catch (e) {
            if (e instanceof BotProtectionError) throw e;
            results.push({ ...v, error: e.message });
            log.err(`[동줍] ${v.name} — ${e.message}`);
        }
    }

    log.ok(`[동줍] 완료 — 총 ${grandTotal}회 전송`);

    // overview 결과로 earliestReturnMs 갱신 (내부 계산보다 정확)
    if (aggrEarliestMs) {
        earliestReturnMs = aggrEarliestMs;
        const sec = Math.round((earliestReturnMs - Date.now()) / 1000);
        // 라벨이 "Attack on ..."이면 출전 중인 부대의 복귀 예상 시각
        // "Return from ..."이면 이미 돌아오는 중
        const isAttack = aggrLabel.startsWith('Attack');
        const desc = isAttack ? '출전중→복귀예상' : '복귀중';
        log.info(`[동줍] 복귀 부대 ${totalCmdCount}개, 가장 빠른 복귀: ${sec}초 후 [${desc}] ${aggrLabel.slice(0,40)}`);
    }

    if (earliestReturnMs) {
        const min = Math.round((earliestReturnMs - Date.now()) / 60000);
        log.info(`[동줍] 다음 라운드: ${min}분 후`);
    }
    return { results, grandTotal, earliestReturnMs };
}

module.exports = { loadFarmPage, sendFarmTemplate, sendFarmFromReport, getOutgoingCommands, getReturnsForVillage, getAllReturnsFromOverview, farmFromVillage, farmAllVillages, BotProtectionError };
