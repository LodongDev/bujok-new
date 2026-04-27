// 병력 자동 양성 — 막사/마구간 큐가 비어있으면 1마리씩 채움
// 캡처 확인:
//   POST /game.php?village={X}&screen=barracks&ajaxaction=train&mode=train
//   Body: units[axe]=200&h={csrf}
//   응답: { success, msg, resources, current_order, population }
// 자원 부족 시 서버가 거부 → 다음 사이클 재시도

const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { randInt } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

class BotProtectionError extends Error {
    constructor(detail) { super(`봇 프로텍션: ${detail.type}`); this.detail = detail; }
}

// 건물별 양성 가능 병종
const BUILDING_UNITS = {
    barracks: ['spear', 'sword', 'axe', 'archer'],
    stable: ['spy', 'light', 'marcher', 'heavy'],
    garage: ['ram', 'catapult'],
};

// 막사/마구간 페이지 데이터 — CSRF, 자원, 큐 상세 (마지막 완료시각 포함)
// 캡처 확인:
//   응답 current_order HTML에 <tr class="lit"> 행
//   각 행: 유닛명, <span class="timer">0:17:16</span> 남은시간, "today at HH:MM:SS" 완료시각
async function getTrainData(cdp, sessionId, baseUrl, villageId, building) {
    const url = `${baseUrl}/game.php?village=${villageId}&screen=${building}`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(400, 800));

    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) throw new BotProtectionError(protection);

    return await evaluate(cdp, sessionId, `
        (() => {
            try {
                const gd = (typeof TribalWars !== 'undefined' && TribalWars.getGameData) ? TribalWars.getGameData() : null;
                const v = gd?.village || {};
                const csrf = gd?.csrf || null;

                // 큐 행 파싱: tr.lit 안에 <span class="timer">시:분:초</span>
                const queue = [];
                let maxRemainSec = 0;
                document.querySelectorAll('tr.lit').forEach(tr => {
                    const txt = (tr.textContent || '').trim();
                    const timer = tr.querySelector('span.timer');
                    if (!timer) return;
                    const t = (timer.textContent || '').trim();
                    const m = t.match(/(\\d+):(\\d{1,2}):(\\d{1,2})/);
                    if (!m) return;
                    const sec = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]);
                    queue.push({ text: txt.slice(0, 60), remainSec: sec });
                    if (sec > maxRemainSec) maxRemainSec = sec;
                });

                return {
                    ok: true,
                    csrf,
                    res: {
                        wood: Math.floor(v.wood || 0),
                        stone: Math.floor(v.stone || 0),
                        iron: Math.floor(v.iron || 0),
                    },
                    queue,
                    queueLength: queue.length,
                    maxRemainSec, // 큐 마지막 항목 완료까지 남은 초
                };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// 양성 요청
async function requestTrain(cdp, sessionId, baseUrl, villageId, building, unitName, count, csrf) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const params = new URLSearchParams();
                params.append('units[' + '${unitName}' + ']', '${count}');
                params.append('h', '${csrf}');
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=${building}&ajaxaction=train&mode=train&', {
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
                if (json.error) return { ok: false, error: Array.isArray(json.error) ? json.error[0] : String(json.error) };
                return { ok: true, success: json.success, msg: json.msg };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// 한 마을 양성 처리 — 우선순위 모드 지원
// trainPlan: [{ building, unit, count, maxQueueLen?: 5 }]
//   plan의 순서가 우선순위. 앞 항목이 자원 부족으로 실패하면 뒤 항목도 스킵 (자원 모으기)
//   큐 가득 같은 다른 사유로 스킵된 경우는 다음 항목 계속 시도
async function trainVillage(cdp, sessionId, baseUrl, village, trainPlan) {
    const sentItems = [];
    const queueByBuilding = {};
    let lastErr = null;
    let priorityResourceFail = false; // 우선순위 항목이 자원 부족이면 후속 스킵

    for (const item of trainPlan) {
        if (priorityResourceFail) {
            log.info(`[양성] ${village.name} ${item.building}/${item.unit}: 우선순위 자원부족으로 스킵`);
            continue;
        }
        try {
            const data = await getTrainData(cdp, sessionId, baseUrl, village.id, item.building);
            if (!data?.ok) { lastErr = data?.error; continue; }
            if (!data.csrf) { lastErr = 'CSRF 없음'; continue; }

            queueByBuilding[item.building] = {
                queueLength: data.queueLength,
                maxRemainSec: data.maxRemainSec,
            };

            const maxQ = item.maxQueueLen ?? 5;
            if (data.queueLength >= maxQ) {
                log.info(`[양성] ${village.name} ${item.building} 큐 가득 (${data.queueLength}) — 스킵 (다음 항목은 시도)`);
                continue; // 큐 가득은 자원 문제가 아니라 다음 항목은 정상 시도
            }

            // 자원 사전 체크 (마을 res 기준) — 가능하면 build cost 페이지에서 읽으면 좋지만 일단 서버 응답에 의존
            const result = await requestTrain(cdp, sessionId, baseUrl, village.id, item.building, item.unit, item.count, data.csrf);
            if (result?.ok) {
                sentItems.push(item);
                log.ok(`[양성] ${village.name} ${item.building}: ${item.unit} × ${item.count}`);
            } else {
                lastErr = result?.error || '실패';
                const isResourceFail = /not enough|insufficient|자원|resource|cannot afford/i.test(lastErr);
                if (isResourceFail) {
                    log.info(`[양성] ${village.name} ${item.unit}: 자원 부족 → 후속 스킵 (자원 보존)`);
                    priorityResourceFail = true; // 우선순위 보존: 뒤 항목도 스킵
                } else {
                    log.warn(`[양성] ${village.name} ${item.unit}: ${lastErr}`);
                }
            }
            await sleep(randInt(500, 1200));
        } catch (e) {
            if (e instanceof BotProtectionError) throw e;
            lastErr = e.message;
        }
    }

    // 다음 체크 시각 = 큐 중 가장 빨리 끝나는 것
    let earliestCompleteSec = Infinity;
    for (const q of Object.values(queueByBuilding)) {
        if (q.queueLength > 0 && q.maxRemainSec > 0) {
            // 큐의 첫 항목 완료까지 남은 시간 < maxRemainSec
            // 정확한 첫 항목 시간은 모르니, 안전하게 maxRemainSec 사용
            // (각 사이클마다 1마리만 발주하므로 maxRemainSec ≈ 1마리 양성시간)
            if (q.maxRemainSec < earliestCompleteSec) earliestCompleteSec = q.maxRemainSec;
        } else {
            // 큐 비었으면 즉시 가능
            earliestCompleteSec = 0;
        }
    }
    if (earliestCompleteSec === Infinity) earliestCompleteSec = 60;

    return { sentItems, queueByBuilding, lastErr, nextCheckSec: earliestCompleteSec };
}

// 전체 마을 양성
async function trainAllVillages(cdp, sessionId, baseUrl, villages, trainPlan) {
    log.info(`[양성] 전체 ${villages.length}개 마을`);
    const results = [];
    let earliestNext = Infinity;
    for (let i = 0; i < villages.length; i++) {
        const v = villages[i];
        try {
            const r = await trainVillage(cdp, sessionId, baseUrl, v, trainPlan);
            results.push({ ...v, ...r });
            if (r.nextCheckSec < earliestNext) earliestNext = r.nextCheckSec;
            if (i < villages.length - 1) await sleep(randInt(2000, 4000));
        } catch (e) {
            if (e instanceof BotProtectionError) throw e;
            results.push({ ...v, error: e.message });
        }
    }
    if (earliestNext === Infinity) earliestNext = 300; // 5분 폴백
    return { results, nextCheckSec: earliestNext };
}

module.exports = { trainVillage, trainAllVillages, getTrainData, requestTrain, BotProtectionError, BUILDING_UNITS };
