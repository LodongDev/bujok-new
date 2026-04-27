// 스나이핑 — 인커밍 도착 직후에 원군이 도달하도록 정밀 타이밍 발사
const { evaluate } = require('./runtime');
const { sleep } = require('./page');
const { gotoPlace, fillForm, clickSupport, waitForConfirm, clickConfirmOk, getAvailableTroops } = require('./place');
const { moveAndClick } = require('./mouse');
const log = require('./log');
const { randInt } = require('./human');

// 이동시간 계산 (자체 — 월드 설정 필요)
// dist = sqrt((x1-x2)^2 + (y1-y2)^2)
// time(min) = dist * unitSpeed / (worldSpeed * unitSpeedFactor)
function calcTravelTimeMs(sourceX, sourceY, targetX, targetY, slowestUnitSpeed, worldSpeed, unitSpeedFactor) {
    const dist = Math.sqrt(Math.pow(sourceX - targetX, 2) + Math.pow(sourceY - targetY, 2));
    const timeMin = dist * slowestUnitSpeed / (worldSpeed * (unitSpeedFactor || 1));
    return timeMin * 60 * 1000;
}

// confirm 화면에서 게임이 표시하는 이동시간 추출 (가장 정확)
async function extractGameTravelTime(cdp, sessionId) {
    const result = await evaluate(cdp, sessionId, `
        (() => {
            const html = document.documentElement.innerHTML;
            // Duration: H:MM:SS 형식
            const durM = html.match(/Duration[:\\s]*?(\\d+):(\\d{2}):(\\d{2})/i);
            if (durM) {
                const sec = parseInt(durM[1]) * 3600 + parseInt(durM[2]) * 60 + parseInt(durM[3]);
                return { source: 'duration', ms: sec * 1000 };
            }
            // data-endtime 속성 (ms 정밀도)
            const endM = html.match(/data-endtime="(\\d+)"/);
            if (endM) {
                return { source: 'endtime', endtime: parseInt(endM[1]) };
            }
            return null;
        })()
    `);
    return result;
}

// 서버 시간 가져오기 (게임 페이지 내 game_data.time_generated)
async function getServerTime(cdp, sessionId) {
    const result = await evaluate(cdp, sessionId, `
        (() => {
            // 게임의 전역 데이터에서 서버 시간
            if (typeof TribalWars !== 'undefined' && TribalWars.getGameData) {
                const gd = TribalWars.getGameData();
                if (gd && gd.time_generated) {
                    return { serverTime: parseFloat(gd.time_generated) * 1000, localTime: Date.now() };
                }
            }
            // 폴백: Timing 객체
            if (typeof Timing !== 'undefined') {
                return { serverTime: Timing.getCurrentServerTime ? Timing.getCurrentServerTime() * 1000 : 0, localTime: Date.now() };
            }
            return { serverTime: 0, localTime: Date.now() };
        })()
    `);
    return result;
}

// 스나이핑 실행
// params:
//   incoming: { arrivalTimestamp, targetVillageId, ... } — 인커밍 정보
//   source: { villageId, x, y } — 출발 마을
//   troops: { spear: N, sword: N, ... } — 보낼 병력
//   offsetMs: 발사 타이밍 오프셋 (양수 = 더 늦게, 기본 +500ms = 인커밍 도착 500ms 후 도착)
async function executeSnipe(cdp, sessionId, baseUrl, { incoming, source, troops, offsetMs = 500 }) {
    log.info('=== 스나이핑 준비 ===');
    log.info(`인커밍 도착: ${incoming.arrivalDate}`);
    log.info(`타겟 마을: ${incoming.targetVillageId}`);
    log.info(`출발 마을: ${source.villageId} (${source.x}|${source.y})`);
    log.info(`병력: ${JSON.stringify(troops)}`);
    log.info(`오프셋: +${offsetMs}ms`);

    // 타겟 좌표 — 인커밍의 타겟 마을 좌표가 필요
    // (incoming에서 가져오거나 source/target 마을 좌표 맵에서)
    const targetX = incoming.targetX;
    const targetY = incoming.targetY;
    if (!targetX || !targetY) {
        throw new Error('타겟 마을 좌표 필요 (incoming.targetX, incoming.targetY)');
    }

    let lastMouse = { x: 500, y: 300 };

    // 1. 광장으로 이동
    log.info('[1/5] 광장 이동...');
    await gotoPlace(cdp, sessionId, baseUrl, source.villageId);
    await sleep(randInt(500, 1200));

    // 2. 폼 입력 (좌표 + 병력)
    log.info('[2/5] 폼 입력...');
    await fillForm(cdp, sessionId, targetX, targetY, troops);
    await sleep(randInt(800, 1500));

    // 3. Support 버튼 클릭
    log.info('[3/5] Support 버튼 클릭...');
    lastMouse = await clickSupport(cdp, sessionId, lastMouse);
    await sleep(randInt(300, 800));

    // 4. confirm 화면 대기
    log.info('[4/5] confirm 화면 대기...');
    const confirmBtn = await waitForConfirm(cdp, sessionId);

    // 4.5 게임 이동시간 추출 (confirm 화면에 표시됨)
    const gameTravelInfo = await extractGameTravelTime(cdp, sessionId);
    let travelTimeMs = null;
    if (gameTravelInfo) {
        if (gameTravelInfo.source === 'duration') {
            travelTimeMs = gameTravelInfo.ms;
            log.info(`게임 이동시간: ${Math.round(travelTimeMs / 1000)}초 (Duration 텍스트)`);
        } else if (gameTravelInfo.source === 'endtime') {
            // endtime은 서버 시간 기준 → 서버 시간과 비교
            const st = await getServerTime(cdp, sessionId);
            if (st.serverTime > 0) {
                const endMs = gameTravelInfo.endtime < 1e12 ? gameTravelInfo.endtime * 1000 : gameTravelInfo.endtime;
                travelTimeMs = endMs - st.serverTime;
                log.info(`게임 이동시간: ${Math.round(travelTimeMs / 1000)}초 (data-endtime)`);
            }
        }
    }

    if (!travelTimeMs) {
        log.warn('게임 이동시간 추출 실패 — confirm 화면에서 Duration 확인 필요');
        throw new Error('이동시간 미확인 — 수동으로 확인 후 재시도');
    }

    // 5. 발사 시점 계산
    // 원하는 도착 시간 = incoming 도착 시간 + offsetMs
    const desiredArrival = incoming.arrivalTimestamp + offsetMs;
    // 발사 시간 = 원하는 도착 - 이동시간
    const fireTime = desiredArrival - travelTimeMs;
    const now = Date.now();
    const waitMs = fireTime - now;

    log.info(`발사 시점: ${new Date(fireTime).toISOString()}`);
    log.info(`예상 도착: ${new Date(desiredArrival).toISOString()}`);
    log.info(`인커밍 도착: ${incoming.arrivalDate}`);
    log.info(`대기: ${Math.round(waitMs / 1000)}초`);

    if (waitMs < 0) {
        const lateSec = Math.round(-waitMs / 1000);
        throw new Error(`발사 시점 이미 지남 (${lateSec}초 전) — 더 빠른 유닛이나 가까운 마을 필요`);
    }

    if (waitMs > 3600000) {
        throw new Error(`1시간 이상 대기 필요 (${Math.round(waitMs / 60000)}분) — 너무 이른 준비`);
    }

    // 3분 이상 남으면 → 30초 전까지 대기 → 페이지 새로고침으로 confirm 재준비
    if (waitMs > 180000) {
        const earlyWait = waitMs - 30000;
        log.info(`${Math.round(earlyWait / 1000)}초 사전 대기 후 재준비...`);
        await sleep(earlyWait);

        // 페이지 새로고침 + 재준비
        log.info('재준비: 폼 재입력 + Support 재클릭...');
        await gotoPlace(cdp, sessionId, baseUrl, source.villageId);
        await sleep(randInt(500, 1000));
        await fillForm(cdp, sessionId, targetX, targetY, troops);
        await sleep(randInt(500, 1000));
        lastMouse = await clickSupport(cdp, sessionId, lastMouse);
        await sleep(randInt(300, 800));
        const newConfirm = await waitForConfirm(cdp, sessionId);
        Object.assign(confirmBtn, newConfirm);

        // 남은 대기 시간 재계산
        const remainMs = fireTime - Date.now();
        if (remainMs > 0) {
            log.info(`최종 대기: ${Math.round(remainMs / 1000)}초`);
            // 3초 전까지 sleep
            if (remainMs > 3000) await sleep(remainMs - 3000);
        }
    } else {
        // 3초 전까지 sleep
        const sleepMs = waitMs - 3000;
        if (sleepMs > 0) {
            log.info(`${Math.round(sleepMs / 1000)}초 대기...`);
            await sleep(sleepMs);
        }
    }

    // 발사 직전 — 정밀 대기
    const finalWait = fireTime - Date.now();
    if (finalWait > 0) {
        log.info(`최종 ${finalWait}ms 대기...`);
        await sleep(finalWait);
    }

    // [5/5] 발사! confirm OK 클릭
    log.ok('[5/5] ★ 발사!');
    await clickConfirmOk(cdp, sessionId, confirmBtn, lastMouse);

    const actualFireTime = Date.now();
    const diffMs = actualFireTime - fireTime;
    log.ok(`발사 완료! (목표 대비 ${diffMs > 0 ? '+' : ''}${diffMs}ms)`);
    log.ok(`예상 도착: ${new Date(actualFireTime + travelTimeMs).toISOString()}`);
    log.ok(`인커밍 도착: ${incoming.arrivalDate}`);

    return {
        success: true,
        actualFireTime,
        expectedArrival: actualFireTime + travelTimeMs,
        incomingArrival: incoming.arrivalTimestamp,
        diffMs,
    };
}

module.exports = { executeSnipe, calcTravelTimeMs, extractGameTravelTime, getServerTime };
