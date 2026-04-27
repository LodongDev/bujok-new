// 인커밍 조회 — 내 마을에 오는 공격/원군 목록 + 상세(도착시간 ms 정밀도)
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const log = require('./log');

// 인커밍 목록 가져오기 (overview_villages 페이지에서 command ID 추출)
async function fetchIncomings(cdp, sessionId, baseUrl, villageId) {
    log.info('인커밍 목록 조회 중...');

    const url = `${baseUrl}/game.php?village=${villageId}&screen=overview_villages&mode=incomings&type=unignored&subtype=all&page=-1`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(500);

    const commands = await evaluate(cdp, sessionId, `
        (() => {
            const result = [];
            // 인커밍 row에서 command ID와 기본 정보 추출
            const rows = document.querySelectorAll('tr.command-row, tr[data-command-id], tr.row_a, tr.row_b');
            for (const tr of rows) {
                // command ID: data 속성 또는 링크에서 추출
                let cmdId = tr.getAttribute('data-command-id');
                if (!cmdId) {
                    const link = tr.querySelector('a[href*="info_command"]');
                    if (link) {
                        const m = link.href.match(/id=(\\d+)/);
                        if (m) cmdId = m[1];
                    }
                }
                if (!cmdId) continue;

                // 타입 (공격/원군)
                const imgAtt = tr.querySelector('img[src*="att"]') || tr.querySelector('img[src*="attack"]');
                const imgSup = tr.querySelector('img[src*="support"]') || tr.querySelector('img[src*="def"]');
                const type = imgAtt ? 'attack' : imgSup ? 'support' : 'unknown';

                // 도착 시간 텍스트
                const timeCell = tr.querySelector('td:last-child, .timer');
                const timeText = (timeCell && timeCell.textContent) ? timeCell.textContent.trim() : '';

                // 출발/도착 마을
                const links = tr.querySelectorAll('a[href*="village="]');
                let sourceVillage = null, targetVillage = null;
                if (links.length >= 2) {
                    const m1 = links[0].href.match(/village=(\\d+)/);
                    const m2 = links[1].href.match(/village=(\\d+)/);
                    if (m1) sourceVillage = { id: parseInt(m1[1]), name: links[0].textContent.trim() };
                    if (m2) targetVillage = { id: parseInt(m2[1]), name: links[1].textContent.trim() };
                }

                result.push({
                    commandId: cmdId,
                    type,
                    timeText,
                    source: sourceVillage,
                    target: targetVillage,
                });
            }
            return result;
        })()
    `);

    // 인커밍이 page에서 안 잡히면 HTML에서 직접 파싱 시도
    if (!commands || commands.length === 0) {
        log.info('DOM에서 못 찾음 → HTML에서 info_command 링크 추출 시도');
        const fallback = await evaluate(cdp, sessionId, `
            (() => {
                const html = document.documentElement.innerHTML;
                const matches = [...html.matchAll(/info_command[^"']*id=(\\d+)/gi)];
                const seen = new Set();
                return matches.map(m => m[1]).filter(id => {
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                }).map(id => ({ commandId: id, type: 'unknown', source: null, target: null }));
            })()
        `);
        return fallback || [];
    }

    return commands;
}

// 개별 인커밍 상세 — 도착시간 ms 정밀도
async function fetchCommandDetails(cdp, sessionId, baseUrl, villageId, commandId) {
    const url = `${baseUrl}/game.php?village=${villageId}&screen=info_command&ajax=details&id=${commandId}`;

    // 현재 페이지 컨텍스트에서 fetch 호출 (진짜 Chrome 헤더/쿠키)
    const resp = await evaluate(cdp, sessionId, `
        (async () => {
            const res = await fetch(${JSON.stringify(url)}, {
                headers: {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'TribalWars-Ajax': '1',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });
            return await res.json();
        })()
    `);

    if (!resp || !resp.response) {
        throw new Error(`command ${commandId} 상세 조회 실패`);
    }

    const r = resp.response;
    const arrivalDate = parseInt(r.time_arrival?.date || 0);
    const arrivalMs = parseInt(r.time_arrival?.millis || 0);
    const arrivalTimestamp = arrivalDate * 1000 + arrivalMs;

    // 유닛 추출
    const units = {};
    if (r.units) {
        for (const [name, info] of Object.entries(r.units)) {
            const count = parseInt(info.count || 0);
            if (count > 0) units[name] = count;
        }
    }

    return {
        commandId,
        type: r.type, // 'attack', 'support'
        sourceVillageId: parseInt(r.village_start?.id || 0),
        targetVillageId: parseInt(r.village_target?.id || 0),
        arrivalTimestamp, // ms 단위 정밀 시각
        arrivalDate: new Date(arrivalTimestamp).toISOString(),
        units,
    };
}

// 전체 인커밍 조회 + 각 상세 → 도착시간 포함 목록
async function getIncomingsWithDetails(cdp, sessionId, baseUrl, villageId) {
    const list = await fetchIncomings(cdp, sessionId, baseUrl, villageId);

    if (list.length === 0) {
        log.info('인커밍 없음');
        return [];
    }

    log.info(`인커밍 ${list.length}건 → 상세 조회 중...`);
    const detailed = [];

    for (const cmd of list) {
        try {
            const detail = await fetchCommandDetails(cdp, sessionId, baseUrl, villageId, cmd.commandId);
            detailed.push({
                ...detail,
                sourceName: cmd.source?.name || null,
                targetName: cmd.target?.name || null,
            });
            await sleep(200 + Math.random() * 300); // 자연스러운 간격
        } catch (e) {
            log.warn(`command ${cmd.commandId} 상세 실패: ${e.message}`);
        }
    }

    // 도착 시간순 정렬
    detailed.sort((a, b) => a.arrivalTimestamp - b.arrivalTimestamp);
    return detailed;
}

module.exports = { fetchIncomings, fetchCommandDetails, getIncomingsWithDetails };
