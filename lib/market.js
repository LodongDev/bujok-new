// 프리미엄 시장(market exchange) 자원 판매
// 캡처된 API 플로우 (확인됨):
//   1. GET  /game.php?village={id}&screen=market&ajax=exchange_data
//      → 현재 stock/capacity/rates/merchants/tax 조회
//   2. POST /game.php?village={id}&screen=market&ajaxaction=exchange_begin
//      Body: sell_wood=N&h={csrf}    (N = 획득하고 싶은 PP)
//      → amount(실제 자원 소비량), rate_hash 반환
//   3. POST /game.php?village={id}&screen=market&ajaxaction=exchange_confirm
//      Body: rate_wood={hash}&sell_wood={amount}&mb=1&h={csrf}
//      → success: true

const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { randInt } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

// 봇 프로텍션 감지 시 던지는 에러 (큐가 잡아서 정지)
class BotProtectionError extends Error {
    constructor(detail) { super(`봇 프로텍션: ${detail.type}`); this.detail = detail; }
}

// 현재 봇 탭이 market exchange 페이지에 있는지 확인, 아니면 이동
// 이동 후 봇 프로텍션 감지 — 감지 시 BotProtectionError 던짐
async function ensureExchangePage(cdp, sessionId, baseUrl, villageId) {
    const url = await evaluate(cdp, sessionId, 'location.href');
    const expectedPath = `village=${villageId}&screen=market&mode=exchange`;
    if (!url || !url.includes(expectedPath)) {
        const target = `${baseUrl}/game.php?village=${villageId}&screen=market&mode=exchange`;
        await navigate(cdp, sessionId, target);
        await waitForLoad(cdp, sessionId);
        await sleep(randInt(500, 1200));
    }
    // 페이지 상태 검사 (캡차/차단 페이지 감지)
    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) {
        throw new BotProtectionError(protection);
    }
}

// ==========================================
// exchange_data 조회 (마을 하나)
// 응답에 시장(stock/capacity/rates) + 마을 자원(game_data.village.res) 모두 포함
// ==========================================
async function getExchangeData(cdp, sessionId, baseUrl, villageId) {
    const result = await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=market&ajax=exchange_data', {
                    headers: { 'TribalWars-Ajax': '1', 'X-Requested-With': 'XMLHttpRequest' },
                });
                const json = await res.json();
                const v = json.game_data?.village || {};
                return {
                    ok: true,
                    // 시장 상태
                    stock: json.response?.stock || {},
                    capacity: json.response?.capacity || {},
                    rates: json.response?.rates || {},
                    tax: json.response?.tax || { buy: 0, sell: 0 },
                    merchants: json.response?.merchants || 0,
                    // 마을 자원
                    villageRes: { wood: v.wood || 0, stone: v.stone || 0, iron: v.iron || 0 },
                    storageMax: v.storage_max || 0,
                    // CSRF
                    csrf: json.game_data?.csrf || null,
                };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);
    return result;
}

// ==========================================
// 자원 판매: begin → confirm
// resource: 'wood' | 'stone' | 'iron'
// ppAmount: 획득하고 싶은 PP 수량
// 반환: { ok, resourceSold, ppGained, error }
// ==========================================
async function sellResource(cdp, sessionId, baseUrl, villageId, resource, ppAmount, csrf) {
    // 1. begin — 견적 받기
    const begin = await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=market&ajaxaction=exchange_begin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: 'sell_${resource}=${ppAmount}&h=${csrf}',
                });
                const text = await res.text();
                if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON (세션 만료?)' };
                const json = JSON.parse(text);
                return { ok: true, response: json.response, fullResponse: json };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);

    if (!begin?.ok) return { ok: false, error: begin?.error || 'begin 실패' };
    const tx = begin.response?.[0];
    if (!tx) {
        return { ok: false, error: 'begin 응답 비어있음' };
    }
    if (tx.error) {
        return { ok: false, error: `begin 에러: ${tx.error}` };
    }
    const resourceAmount = Math.abs(tx.amount);      // 실제 소비할 자원
    const ppGained = Math.abs(tx.cost);              // 실제 획득 PP
    const rateHash = tx.rate_hash;
    // 시장 포화 시 서버가 amount=0 또는 cost=0으로 응답할 수 있음
    if (!resourceAmount || ppGained === 0) {
        return { ok: false, error: 'amount=0 (시장 포화)' };
    }
    if (!rateHash) {
        return { ok: false, error: '견적 응답: rate_hash 없음' };
    }

    // begin → confirm 사이 사람이 확인 버튼 누를 때까지의 시간 (1.5~3초)
    await sleep(randInt(1500, 3000));

    // 2. confirm — 실제 실행
    const confirm = await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const body = 'rate_${resource}=${rateHash}&sell_${resource}=${resourceAmount}&mb=1&h=${csrf}';
                const res = await fetch('${baseUrl}/game.php?village=${villageId}&screen=market&ajaxaction=exchange_confirm', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: body,
                });
                const text = await res.text();
                if (!text || text.startsWith('<')) return { ok: false, error: 'non-JSON' };
                const json = JSON.parse(text);
                // transactions 안의 error 필드도 확인
                const txs = json.response?.transactions || [];
                const txErrors = txs.filter(t => t.error).map(t => t.error);
                return {
                    ok: true,
                    success: json.response?.success || false,
                    txErrors,
                    errMessage: json.error?.[0] || null,
                };
            } catch (e) { return { ok: false, error: e.message }; }
        })()
    `);

    if (!confirm?.ok) return { ok: false, error: confirm?.error || 'confirm 실패' };
    if (!confirm.success) {
        const detail = confirm.errMessage || confirm.txErrors?.join(';') || '알 수 없음';
        return { ok: false, error: `confirm 실패: ${detail}` };
    }

    return {
        ok: true,
        resource,
        resourceSold: resourceAmount,
        ppGained,
    };
}

// ==========================================
// 한 마을의 모든 자원 최대한 판매
// 봇 탭을 해당 마을의 market exchange 페이지로 이동한 후 작업
// ==========================================
async function sellAllFromVillage(cdp, sessionId, baseUrl, villageId, villageName) {
    // 1. 해당 마을의 시장 교환 페이지로 이동 (Referer 올바르게 맞춤)
    await ensureExchangePage(cdp, sessionId, baseUrl, villageId);

    // 2. exchange_data 조회 (현재 페이지 컨텍스트에서)
    const data = await getExchangeData(cdp, sessionId, baseUrl, villageId);
    if (!data?.ok) {
        return { status: 'error', error: data?.error || '조회 실패' };
    }
    if (!data.csrf) {
        return { status: 'error', error: 'CSRF 없음' };
    }
    if (data.merchants === 0) {
        return { status: 'skip', reason: '상인 없음' };
    }

    const { stock, capacity, rates, tax, csrf, villageRes } = data;
    const results = [];
    const fullResources = [];
    const sellOrder = ['wood', 'stone', 'iron'];

    for (const resource of sellOrder) {
        const marketStock = stock[resource] || 0;
        const marketCap = capacity[resource] || 0;
        const villageAmount = villageRes[resource] || 0;
        const rate = rates[resource] || 0;

        if (rate <= 0) continue;

        // 마을에 자원 없음 — 스킵
        if (villageAmount <= 0) {
            log.debug(`  [${villageName}] ${resource}: 마을 자원 0`);
            continue;
        }

        // 시장 여유 없으면 begin 요청 아예 생략 (UI에서도 '꽉참' 표시)
        const marketRoom = marketCap - marketStock;
        if (marketRoom <= 0) {
            log.debug(`  [${villageName}] ${resource}: 시장 여유 0 → 요청 생략`);
            fullResources.push(resource);
            continue;
        }

        // 여유 있으면 판매량 계산 (여유분 기준, 소량이어도 시도)
        const sellableAmount = Math.min(villageAmount, marketRoom);
        const estimatedPP = Math.max(1, Math.floor(sellableAmount * rate * (1 - (tax.sell || 0))));
        log.info(`  [${villageName}] ${resource}: 마을=${villageAmount}, 시장여유=${marketRoom} → ${estimatedPP}PP 시도`);

        const result = await sellResource(cdp, sessionId, baseUrl, villageId, resource, estimatedPP, csrf);
        if (result.ok) {
            log.ok(`  [${villageName}] ${resource} ${result.resourceSold} → ${result.ppGained}PP`);
            results.push(result);
        } else {
            // 서버 응답에서 amount가 0이면 진짜 판매 불가 = 시장 가득참
            if (result.error?.includes('amount=0') || result.error?.includes('full') ||
                result.error?.includes('capacity') || result.error?.includes('가득')) {
                fullResources.push(resource);
                log.info(`  [${villageName}] ${resource} 판매 불가 (시장 포화)`);
            } else {
                log.warn(`  [${villageName}] ${resource} 실패: ${result.error}`);
            }
        }

        // 자원 간 딜레이 — 사람이 다음 자원으로 전환하는 시간
        await sleep(randInt(2000, 4000));
    }

    if (results.length === 0) {
        const reason = fullResources.length > 0
            ? `시장 가득참 (${fullResources.join(',')})`
            : '판매 가능 자원 없음';
        return { status: 'skip', reason, fullResources };
    }

    const totalPP = results.reduce((s, r) => s + r.ppGained, 0);
    return { status: 'ok', sold: results, totalPP, fullResources };
}

// 좌표에서 K-지역 코드 계산 (예: (184|485) → K41, (227|518) → K52)
function getKRegion(x, y) {
    return Math.floor(y / 100) * 10 + Math.floor(x / 100);
}

// ==========================================
// 전체 마을 판매 (지역별 최적화)
// PP 풀은 지역(K코드)별로 공유 — 한 지역 market_data 한 번만 체크
// 지역 시장이 가득 차 있으면 그 지역 전체 마을 스킵
// ==========================================
async function sellAllVillages(cdp, sessionId, baseUrl, villages) {
    // 지역별로 그룹화
    const regionGroups = {};
    for (const v of villages) {
        if (!v.x || !v.y) continue;
        const k = getKRegion(v.x, v.y);
        if (!regionGroups[k]) regionGroups[k] = [];
        regionGroups[k].push(v);
    }

    const regionKeys = Object.keys(regionGroups).sort();
    log.info(`[시장] 전체 ${villages.length}개 마을, ${regionKeys.length}개 지역 (K${regionKeys.join(',K')})`);

    const results = [];
    let totalPP = 0;

    for (const k of regionKeys) {
        const regionVillages = regionGroups[k];
        log.info(`[시장] K${k} — ${regionVillages.length}개 마을`);

        try {
            // 1. 지역 상태 1회 조회 (첫 마을로)
            const probe = regionVillages[0];
            await ensureExchangePage(cdp, sessionId, baseUrl, probe.id);
            const probeData = await getExchangeData(cdp, sessionId, baseUrl, probe.id);
            if (!probeData?.ok) {
                log.warn(`[시장] K${k} 상태 조회 실패: ${probeData?.error}`);
                for (const v of regionVillages) results.push({ ...v, status: 'error', error: probeData?.error });
                continue;
            }

            // 2. 시장 여유 계산 — stock == capacity면 요청 생략
            const room = {
                wood: (probeData.capacity?.wood || 0) - (probeData.stock?.wood || 0),
                stone: (probeData.capacity?.stone || 0) - (probeData.stock?.stone || 0),
                iron: (probeData.capacity?.iron || 0) - (probeData.stock?.iron || 0),
            };
            log.info(`[시장] K${k} 여유: wood=${room.wood}, stone=${room.stone}, iron=${room.iron}`);

            if (room.wood <= 0 && room.stone <= 0 && room.iron <= 0) {
                log.info(`[시장] K${k} 모두 가득참 → 전체 스킵 (요청 안함)`);
                for (const v of regionVillages) {
                    results.push({ ...v, status: 'skip', reason: `K${k} 시장 가득참 (전체)` });
                }
                continue;
            }

            // 3. 여유 있는 자원만 있을 때 마을 순회
            let regionPP = 0;
            for (let i = 0; i < regionVillages.length; i++) {
                const v = regionVillages[i];
                try {
                    const result = await sellAllFromVillage(cdp, sessionId, baseUrl, v.id, v.name);
                    results.push({ ...v, ...result });
                    if (result.status === 'ok') {
                        totalPP += result.totalPP;
                        regionPP += result.totalPP;
                        log.ok(`[시장] ${v.name} — ${result.totalPP}PP`);
                    } else if (result.status === 'skip') {
                        log.info(`[시장] ${v.name} — ${result.reason}`);
                    } else {
                        log.warn(`[시장] ${v.name} — ${result.error}`);
                    }
                    if (i < regionVillages.length - 1) {
                        await sleep(randInt(4000, 8000));
                    }
                } catch (e) {
                    results.push({ ...v, status: 'error', error: e.message });
                    log.err(`[시장] ${v.name} — ${e.message}`);
                }
            }
            log.ok(`[시장] K${k} 지역 완료 — ${regionPP}PP`);
        } catch (e) {
            log.err(`[시장] K${k} prob 실패: ${e.message}`);
            for (const v of regionVillages) results.push({ ...v, status: 'error', error: e.message });
        }
    }

    log.ok(`[시장] 완료 — 총 ${totalPP}PP 획득`);
    return { results, totalPP };
}

module.exports = { getExchangeData, sellResource, sellAllFromVillage, sellAllVillages, BotProtectionError };
