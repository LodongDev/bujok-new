// 자동 건물 업그레이드 — 캡처 기반 구현
// API:
//   GET /game.php?village={X}&screen=main
//     → TribalWars.updateGameData({village:{buildings,res,wood_prod,...}})
//     → HTML #build_queue (현재 큐)
//     → main_buildrow_{name}에 data-cost-wood/stone/iron, data-level-next
//   POST /game.php?village={X}&screen=main&ajaxaction=upgrade_building&type=main
//     Body: id={name}&force=1&destroy=0&source={X}&h={csrf}

const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { randInt } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

class BotProtectionError extends Error {
    constructor(detail) { super(`봇 프로텍션: ${detail.type}`); this.detail = detail; }
}

const BUILDINGS = [
    'main','barracks','stable','garage','smith','place','statue','market',
    'wood','stone','iron','farm','storage','hide','wall','snob','watchtower','church',
];

// 본부 페이지 데이터 가져오기
async function getMainData(cdp, sessionId, baseUrl, villageId) {
    const url = `${baseUrl}/game.php?village=${villageId}&screen=main`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(500, 1000));

    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) throw new BotProtectionError(protection);

    return await evaluate(cdp, sessionId, `
        (() => {
            try {
                const gd = (typeof TribalWars !== 'undefined' && TribalWars.getGameData)
                    ? TribalWars.getGameData() : null;
                const v = gd?.village || {};
                const csrf = gd?.csrf || null;

                // 현재 자원
                const res = {
                    wood: Math.floor(v.wood || v.wood_float || 0),
                    stone: Math.floor(v.stone || v.stone_float || 0),
                    iron: Math.floor(v.iron || v.iron_float || 0),
                };
                // 생산량 (초당)
                const prod = {
                    wood: parseFloat(v.wood_prod) || 0,
                    stone: parseFloat(v.stone_prod) || 0,
                    iron: parseFloat(v.iron_prod) || 0,
                };
                const storageMax = v.storage_max || 0;

                // 현재 건물 레벨
                const levels = {};
                for (const [k, lv] of Object.entries(v.buildings || {})) {
                    levels[k] = parseInt(lv);
                }

                // 각 건물 row에서 비용/다음레벨/업그레이드 가능 여부
                const rows = {};
                for (const tr of document.querySelectorAll('tr[id^="main_buildrow_"]')) {
                    const name = tr.id.replace('main_buildrow_', '');
                    const link = tr.querySelector('a[data-building]');
                    const costWood = parseInt(tr.querySelector('td.cost_wood')?.getAttribute('data-cost')) || 0;
                    const costStone = parseInt(tr.querySelector('td.cost_stone')?.getAttribute('data-cost')) || 0;
                    const costIron = parseInt(tr.querySelector('td.cost_iron')?.getAttribute('data-cost')) || 0;
                    const nextLevel = link ? parseInt(link.getAttribute('data-level-next')) : null;
                    const inactive = !!tr.querySelector('span.inactive:not([style*="display: none"])');
                    const canUpgrade = !!link && !inactive;
                    rows[name] = {
                        costWood, costStone, costIron,
                        nextLevel, canUpgrade,
                    };
                }

                // 현재 큐
                const queueItems = [];
                const qTable = document.getElementById('build_queue');
                if (qTable) {
                    for (const tr of qTable.querySelectorAll('tr[class*="buildorder_"]')) {
                        const cls = tr.className || '';
                        const m = cls.match(/buildorder_([a-z_]+)/);
                        if (m) queueItems.push(m[1]);
                    }
                }

                return {
                    ok: true, csrf, res, prod, storageMax, levels, rows, queue: queueItems,
                };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
}

// 건물 업그레이드 요청
async function upgradeBuilding(cdp, sessionId, baseUrl, villageId, buildingId, csrf) {
    return await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const params = new URLSearchParams();
                params.append('id', '${buildingId}');
                params.append('force', '1');
                params.append('destroy', '0');
                params.append('source', '${villageId}');
                params.append('h', '${csrf}');
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=main&', {
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

// 우선순위 리스트에서 다음 빌드할 건물 찾기
// priority: [{ building: 'wood', target: 20 }, ...]
// levels: 현재 레벨
// queue: 현재 큐에 있는 건물 리스트 (이미 발주된 건 +1로 처리)
function findNextTarget(priority, levels, queue) {
    // 큐에 있는 건물은 해당 개수만큼 레벨 가중
    const queueCount = {};
    for (const b of queue) queueCount[b] = (queueCount[b] || 0) + 1;
    const effectiveLevels = {};
    for (const [k, lv] of Object.entries(levels)) {
        effectiveLevels[k] = lv + (queueCount[k] || 0);
    }

    for (const item of priority) {
        const curLv = effectiveLevels[item.building] || 0;
        if (curLv < item.target) {
            return { building: item.building, currentLevel: levels[item.building] || 0, targetLevel: item.target };
        }
    }
    return null;
}

// 자원 부족 시 필요 대기시간 (초)
function estimateWaitSeconds(cost, res, prod) {
    let maxWait = 0;
    for (const r of ['wood', 'stone', 'iron']) {
        const need = (cost[r] || 0) - (res[r] || 0);
        if (need <= 0) continue;
        const p = prod[r] || 0;
        if (p <= 0) return Infinity; // 생산 안되는 자원 필요
        const sec = Math.ceil(need / p);
        if (sec > maxWait) maxWait = sec;
    }
    return maxWait;
}

// 한 마을의 다음 빌드 처리
// 반환: { status: 'built' | 'waiting' | 'done' | 'full_queue' | 'error', waitSec?, nextBuilding?, error? }
async function processBuildVillage(cdp, sessionId, baseUrl, village, priority, options = {}) {
    const maxQueueSize = options.maxQueueSize || 2;

    const data = await getMainData(cdp, sessionId, baseUrl, village.id);
    if (!data?.ok) return { status: 'error', error: data?.error || '조회 실패' };
    if (!data.csrf) return { status: 'error', error: 'CSRF 없음' };

    // 큐 가득참?
    if (data.queue.length >= maxQueueSize) {
        return { status: 'full_queue', queueLength: data.queue.length };
    }

    // 다음 타겟
    const next = findNextTarget(priority, data.levels, data.queue);
    if (!next) return { status: 'done', reason: '우선순위 리스트 모두 완료' };

    const row = data.rows[next.building];
    if (!row) return { status: 'error', error: `건물 row 없음: ${next.building}` };

    const cost = { wood: row.costWood, stone: row.costStone, iron: row.costIron };

    // 자원 부족?
    const waitSec = estimateWaitSeconds(cost, data.res, data.prod);
    if (waitSec > 0 && waitSec !== Infinity) {
        return {
            status: 'waiting',
            nextBuilding: next.building,
            currentLevel: next.currentLevel,
            targetLevel: next.targetLevel,
            waitSec,
            cost, res: data.res, prod: data.prod,
        };
    }
    if (waitSec === Infinity) {
        return { status: 'error', error: `${next.building} 업그레이드: 자원 생산 불가 (상점/광산 필요?)` };
    }

    // 업그레이드 실행
    const result = await upgradeBuilding(cdp, sessionId, baseUrl, village.id, next.building, data.csrf);
    if (!result?.ok) {
        return { status: 'error', error: result?.error || '업그레이드 실패' };
    }
    log.ok(`[건설] ${village.name} ${next.building} Lv${next.currentLevel}→${next.currentLevel+1} 발주`);
    return {
        status: 'built',
        building: next.building,
        toLevel: next.currentLevel + 1,
        completeAtSec: result.response?.date_complete,
    };
}

module.exports = {
    BUILDINGS, getMainData, upgradeBuilding, findNextTarget, estimateWaitSeconds,
    processBuildVillage, BotProtectionError,
};
