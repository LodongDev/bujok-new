// 스캐빈징 모듈 — 캡처 데이터 기반 정확 구현
// - 봇 탭에서 스캐빈징 페이지로 navigate (사람처럼)
// - DOM에서 열린 옵션/가용 병력 파악
// - 게임 정확 공식으로 동시 완료 배분
// - 옵션 하나씩 개별 전송 (캡처 확인: 높은 옵션부터 1개씩 POST)
// - 마우스 클릭 기반 (감지 방지)

const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { moveAndClick } = require('./mouse');
const { randInt, gaussian } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

class BotProtectionError extends Error {
    constructor(detail) { super(`봇 프로텍션: ${detail.type}`); this.detail = detail; }
}

// ==========================================
// 게임 상수 (캡처 + 게임 JS에서 확인)
// ==========================================
// 스캐빈징에 사용할 유닛 — 창/검/도끼/궁만
const SCAV_UNITS = {
    spear:   { carry: 25, pop: 1 },
    sword:   { carry: 15, pop: 1 },
    axe:     { carry: 10, pop: 1 },
    archer:  { carry: 10, pop: 1 },
};
const SCAV_UNIT_FIELDS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];

const OPTIONS = {
    1: { loot_factor: 0.10, duration_exponent: 0.45, duration_initial: 1800, duration_factor: 1 },
    2: { loot_factor: 0.25, duration_exponent: 0.45, duration_initial: 1800, duration_factor: 1 },
    3: { loot_factor: 0.50, duration_exponent: 0.45, duration_initial: 1800, duration_factor: 1 },
    4: { loot_factor: 0.75, duration_exponent: 0.45, duration_initial: 1800, duration_factor: 1 },
};

// 최소 carry 임계값 — 이 값보다 작으면 마을 스킵 (30분 대기하는데 이득 너무 적음)
const MIN_TOTAL_CARRY = 200;

// ==========================================
// 게임 정확 공식 (게임 JS에서 추출, 캡처로 검증)
// calcDurationSeconds(carry) = round((pow(carry * 100*factor * carry * factor, 0.45) + 1800) * 1)
// = round(pow(carry² × 100 × factor², 0.45) + 1800)
// ==========================================
function calcDuration(carry, lootFactor) {
    const lootPercent = 100 * lootFactor;
    return Math.round(
        (Math.pow(carry * lootPercent * carry * lootFactor, 0.45) + 1800) * 1
    );
}

// 역산: 목표 duration에 필요한 carry
function carryForDuration(targetDuration, lootFactor) {
    const inner = Math.pow(targetDuration - 1800, 1 / 0.45);
    return Math.sqrt(inner / (100 * lootFactor * lootFactor));
}

// ==========================================
// 동시 완료 배분 — 정확 공식 기반
// ==========================================
function distributeEqual(unitCounts, availableOptionIds) {
    // 가용 병력 → carry 총량 계산
    const units = [];
    let totalCarry = 0;
    for (const [unit, info] of Object.entries(SCAV_UNITS)) {
        const count = unitCounts[unit] || 0;
        if (count > 0) {
            units.push({ unit, count, carry: info.carry });
            totalCarry += count * info.carry;
        }
    }
    if (totalCarry === 0 || availableOptionIds.length === 0) return [];

    // 목표: 모든 옵션이 같은 시간에 끝나도록 carry 배분
    // 전체 carry를 한 번에 넣었을 때의 최대 duration 기준으로 역산
    // 이진 탐색으로 목표 duration 찾기 (모든 옵션의 carry 합 = totalCarry)
    const opts = availableOptionIds
        .map(id => ({ id, factor: OPTIONS[id]?.loot_factor || 0.1 }))
        .sort((a, b) => b.factor - a.factor); // 높은 옵션부터

    let lo = 1801, hi = 500000;
    for (let iter = 0; iter < 100; iter++) {
        const mid = (lo + hi) / 2;
        let sumCarry = 0;
        for (const opt of opts) {
            sumCarry += carryForDuration(mid, opt.factor);
        }
        if (sumCarry < totalCarry) lo = mid;
        else hi = mid;
        if (hi - lo < 0.1) break;
    }
    const targetDuration = (lo + hi) / 2;

    // 각 옵션별 필요 carry 계산
    const optCarries = {};
    let sumNeeded = 0;
    for (const opt of opts) {
        const needed = carryForDuration(targetDuration, opt.factor);
        optCarries[opt.id] = Math.max(1, Math.round(needed));
        sumNeeded += optCarries[opt.id];
    }

    // 반올림 오차 보정 — 마지막 옵션에 나머지 carry 몰기
    const lastOpt = opts[opts.length - 1];
    optCarries[lastOpt.id] += totalCarry - sumNeeded;

    // carry → 병력 변환 (효율 높은 유닛부터)
    units.sort((a, b) => b.carry - a.carry); // carry 높은 유닛 우선
    const remaining = {};
    for (const u of units) remaining[u.unit] = u.count;

    const result = [];
    for (const opt of opts) {
        const targetCarry = optCarries[opt.id];
        if (targetCarry <= 0) continue;

        const troops = {};
        let assignedCarry = 0;

        for (const u of units) {
            const avail = remaining[u.unit] || 0;
            if (avail <= 0) continue;
            const need = Math.ceil((targetCarry - assignedCarry) / u.carry);
            const use = Math.min(avail, Math.max(0, need));
            if (use > 0) {
                troops[u.unit] = use;
                remaining[u.unit] -= use;
                assignedCarry += use * u.carry;
            }
            if (assignedCarry >= targetCarry) break;
        }

        if (assignedCarry > 0) {
            const duration = calcDuration(assignedCarry, OPTIONS[opt.id].loot_factor);
            result.push({ optionId: opt.id, troops, carryTotal: assignedCarry, duration });
        }
    }

    return result;
}

// 마을별 허용 병종 화이트리스트 적용
// - null/undefined: 설정 없음 → 전체 4종 사용 (기본값)
// - []: 명시적 빈 선택 → 사용 안 함 (마을 스킵)
// - ['spear','axe']: 명시된 병종만 사용
function filterUnitsByAllowed(unitCounts, allowedUnits) {
    if (allowedUnits == null) return { ...unitCounts };
    const allowed = new Set(allowedUnits);
    const out = {};
    for (const u of Object.keys(SCAV_UNITS)) {
        out[u] = allowed.has(u) ? (unitCounts[u] || 0) : 0;
    }
    return out;
}

// ==========================================
// 한 마을 스캐빈징 (사람처럼 — 봇 탭에서 실행)
// options.allowedUnits: ['spear','sword','axe','archer'] 중 사용할 것만 (생략시 전체)
// ==========================================
async function scavengeVillage(cdp, sessionId, baseUrl, villageId, options = {}) {
    // 1. 스캐빈징 페이지로 navigate (사람처럼 페이지 이동)
    const scavUrl = `${baseUrl}/game.php?village=${villageId}&screen=place&mode=scavenge`;
    await navigate(cdp, sessionId, scavUrl);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(800, 1500));

    // 1.5 봇 프로텍션 감지
    const protection = await checkBotProtection(cdp, sessionId);
    if (protection.detected) {
        throw new BotProtectionError(protection);
    }

    // 2. DOM에서 게임 데이터 추출 (var village = {...})
    const data = await evaluate(cdp, sessionId, `
        (() => {
            try {
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || '';
                    const m = text.match(/var\\s+village\\s*=\\s*(\\{[\\s\\S]*?\\});\\s/);
                    if (m) {
                        const village = JSON.parse(m[1]);
                        // CSRF
                        let csrf = null;
                        const csrfM = document.documentElement.innerHTML.match(/&h=([a-f0-9]+)/);
                        if (csrfM) csrf = csrfM[1];
                        if (!csrf && typeof TribalWars !== 'undefined' && TribalWars.getGameData) {
                            csrf = TribalWars.getGameData().csrf;
                        }
                        return {
                            status: 'data',
                            villageId: village.village_id,
                            units: village.unit_counts_home || {},
                            options: village.options || {},
                            csrf,
                        };
                    }
                }
                return { status: 'error', error: 'village 데이터 못 찾음' };
            } catch (e) { return { status: 'error', error: e.message }; }
        })()
    `);

    if (!data || data.status === 'error') {
        return { status: 'error', error: data?.error || 'unknown' };
    }
    if (!data.csrf) {
        return { status: 'error', error: 'CSRF 못 찾음' };
    }

    // 3. 옵션 상태 판단 (규칙: 전부 열림 + 진행 중 없음 필요)
    const available = [];
    const running = [];
    const locked = [];
    let maxReturnTime = 0; // 가장 늦게 복귀하는 옵션의 시각 (ms)
    for (const [id, opt] of Object.entries(data.options)) {
        const numId = parseInt(id);
        if (opt.is_locked) {
            locked.push(numId);
        } else if (opt.scavenging_squad) {
            running.push(numId);
            const rt = (opt.scavenging_squad.return_time || 0) * 1000;
            if (rt > maxReturnTime) maxReturnTime = rt;
        } else {
            available.push(numId);
        }
    }

    // 진행 중인 옵션 있으면 전체 스킵 — 모든 옵션 복귀 후 재실행
    if (running.length > 0) {
        return {
            status: 'skip',
            reason: `진행 중 ${running.length}개`,
            nextAvailableAt: maxReturnTime || null,
        };
    }

    if (available.length === 0) {
        return { status: 'skip', reason: `모든 옵션 잠금 ${locked.length}개` };
    }

    // 4. 가용 병력 체크 (마을별 허용 병종 화이트리스트 적용)
    const allowedUnits = options.allowedUnits;
    const usableUnits = filterUnitsByAllowed(data.units, allowedUnits);
    let totalCarry = 0;
    for (const [unit, info] of Object.entries(SCAV_UNITS)) {
        totalCarry += (usableUnits[unit] || 0) * info.carry;
    }
    if (totalCarry === 0) {
        const reason = allowedUnits && allowedUnits.length > 0
            ? `허용 병종(${allowedUnits.join(',')}) 가용 병력 없음`
            : '가용 병력 없음';
        return { status: 'skip', reason };
    }
    if (totalCarry < MIN_TOTAL_CARRY) {
        return { status: 'skip', reason: `병력 부족 (carry ${totalCarry} < ${MIN_TOTAL_CARRY})` };
    }

    // 5. 동시 완료 배분 계산 (필터링된 병력만)
    const squads = distributeEqual(usableUnits, available);
    if (squads.length === 0) {
        return { status: 'skip', reason: '배분 불가' };
    }

    log.info(`  배분: ${squads.map(s => `opt${s.optionId}→${s.carryTotal}carry(${Math.round(s.duration/60)}분)`).join(', ')}`);

    // 6. 옵션별 개별 전송 — API 직접 전송
    //    각 send 직전에 병력 체크: 누적 사용량이 home_units 초과하면 스킵 (헛 요청 방지)
    //    또한 squad 총 인원 < 10 이면 TW가 거부 (서버 에러: "at least 10 villagers") → 스킵
    const SQUAD_MIN_TROOPS = 10;
    const sentSquads = [];
    const used = {}; // unit → 누적 사용량
    for (const squad of squads) {
        // 1) 최소 인원 사전 체크 — TW 서버 최소 10명 요구
        const squadTotal = Object.values(squad.troops || {}).reduce((s, n) => s + (n || 0), 0);
        if (squadTotal < SQUAD_MIN_TROOPS) {
            log.warn(`  opt${squad.optionId} 사전 체크 스킵 — 인원 부족 (${squadTotal} < ${SQUAD_MIN_TROOPS}, TW 최소값)`);
            continue;
        }
        // 2) 병력 사전 체크 — 이 squad의 troops가 보유량 안에 있나?
        let insufficient = null;
        for (const [unit, n] of Object.entries(squad.troops || {})) {
            const have = data.units[unit] || 0;
            const already = used[unit] || 0;
            if (already + n > have) {
                insufficient = `${unit} 부족 (필요 ${already + n}, 보유 ${have})`;
                break;
            }
        }
        if (insufficient) {
            log.warn(`  opt${squad.optionId} 사전 체크 스킵 — ${insufficient}`);
            continue;
        }

        const optStart = Date.now();
        await sleep(randInt(800, 1800));

        const sendOk = await sendSquadByApi(cdp, sessionId, villageId, squad, data.csrf);
        const elapsed = Math.round((Date.now() - optStart) / 1000);
        if (sendOk) {
            sentSquads.push(squad);
            // 누적 사용량 갱신 (서버 보유량은 차감됐지만 우리 data.units는 stale)
            for (const [u, n] of Object.entries(squad.troops || {})) {
                used[u] = (used[u] || 0) + n;
            }
            log.info(`  opt${squad.optionId} 전송 성공 (carry=${squad.carryTotal}, ${elapsed}초)`);
        } else {
            log.warn(`  opt${squad.optionId} 전송 실패`);
        }
    }

    if (sentSquads.length === 0) {
        return { status: 'error', error: '전송된 옵션 없음' };
    }

    return { status: 'ok', squads: sentSquads, running, locked };
}

// ==========================================
// API 직접 전송 폴백 (캡처된 형식 그대로)
// 캡처: POST /game.php?village={id}&screen=scavenge_api&ajaxaction=send_squads
// 캡처: 한 번에 1개 옵션만 전송, 0인 유닛 생략 가능
// ==========================================
async function sendSquadByApi(cdp, sessionId, villageId, squad, csrf) {
    const result = await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const troops = ${JSON.stringify(squad.troops)};
                const params = new URLSearchParams();
                params.append('squad_requests[0][village_id]', '${villageId}');
                // 0이 아닌 유닛만 포함 (캡처 확인: 두 번째 전송부터 0인 건 생략)
                for (const [unit, count] of Object.entries(troops)) {
                    params.append('squad_requests[0][candidate_squad][unit_counts][' + unit + ']', count);
                }
                params.append('squad_requests[0][candidate_squad][carry_max]', '${squad.carryTotal}');
                params.append('squad_requests[0][option_id]', '${squad.optionId}');
                params.append('squad_requests[0][use_premium]', 'false');
                params.append('h', '${csrf}');

                const res = await fetch('/game.php?village=${villageId}&screen=scavenge_api&ajaxaction=send_squads', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'TribalWars-Ajax': '1',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: params.toString(),
                });
                // 응답 텍스트로 받아서 JSON 시도 (세션 만료 시 XML/HTML 응답)
                const text = await res.text();
                if (!text || text.startsWith('<')) {
                    return { success: false, error: 'non-JSON 응답 (세션 만료?)' };
                }
                const json = JSON.parse(text);
                const v = json.response?.villages?.['${villageId}'];
                const opt = v?.options?.['${squad.optionId}'];
                const hasSquad = !!opt?.scavenging_squad;
                // 캡처 검증 (samples): 성공 시 json.response.squad_responses = [{success:true}]
                const squadResp = json.response?.squad_responses?.[0];
                const apiSuccess = squadResp?.success === true;
                let failReason = null;
                if (!hasSquad || !apiSuccess) {
                    failReason = squadResp?.error
                        || squadResp?.error_message
                        || (squadResp?.success === false ? 'squad_responses.success=false' : null)
                        || json.error
                        || json.error_message
                        || (Array.isArray(json.errors) ? json.errors.join('; ') : null)
                        || json.response?.error
                        || (typeof json.response === 'string' ? json.response.slice(0, 200) : null)
                        || 'hasSquad=false (응답에 squad 정보 없음)';
                }
                return { success: hasSquad && apiSuccess, response: json, failReason, squadResp };
            } catch (e) {
                return { success: false, error: e.message };
            }
        })()
    `);
    if (result?.success) return true;
    if (result?.error) log.warn(`    API 에러: ${result.error}`);
    else if (result?.failReason) {
        const r = result.response || {};
        const v = r.response?.villages?.[String(villageId)];
        const optInfo = v?.options ? Object.fromEntries(
            Object.entries(v.options).map(([id, o]) => [id, {
                locked: o.is_locked,
                squad: !!o.scavenging_squad,
            }])
        ) : null;
        log.warn(`    API 실패: ${result.failReason}`);
        log.warn(`    squad_responses[0]: ${JSON.stringify(result.squadResp)}`);
        log.warn(`    옵션 상태: ${JSON.stringify(optInfo)}`);
    }
    return false;
}

// ==========================================
// scavenge_mass로 전체 마을 상태 조회 (캡처 확인)
// GET /game.php?village={any}&screen=place&mode=scavenge_mass
// → ScavengeMassScreen 생성자의 3번째 인자에 모든 마을 데이터 배열
// ==========================================
async function getMassStatus(cdp, sessionId, baseUrl) {
    log.info('[스캐빈징] scavenge_mass 페이지에서 전체 상태 조회...');
    await navigate(cdp, sessionId, `${baseUrl}/game.php?screen=place&mode=scavenge_mass`);
    await waitForLoad(cdp, sessionId);
    await sleep(randInt(800, 1500));

    const data = await evaluate(cdp, sessionId, `
        (() => {
            try {
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || '';
                    const m = text.match(/new ScavengeMassScreen\\(([\\s\\S]*?)\\);\\s*screen\\.init/);
                    if (!m) continue;
                    // 3번째 JSON 블록 추출 (villages 배열)
                    const argsStr = m[1];
                    let depth = 0, start = -1, blockIdx = 0;
                    for (let i = 0; i < argsStr.length; i++) {
                        if (argsStr[i] === '{' || argsStr[i] === '[') {
                            if (depth === 0) start = i;
                            depth++;
                        } else if (argsStr[i] === '}' || argsStr[i] === ']') {
                            depth--;
                            if (depth === 0) {
                                if (blockIdx === 2) return JSON.parse(argsStr.substring(start, i+1));
                                blockIdx++;
                            }
                        }
                    }
                }
                return { error: 'ScavengeMassScreen 데이터 못 찾음' };
            } catch (e) { return { error: e.message }; }
        })()
    `);

    return data;
}

// ==========================================
// 전체 마을 스캐빈징
// ==========================================
async function scavengeAll(cdp, sessionId, baseUrl, villages, onProgress, options = {}) {
    // options.unitsByVillage: { villageId: ['spear','axe',...] } 마을별 허용 병종
    log.info(`[스캐빈징] 대상 ${villages.length}개 마을`);

    // 1. scavenge_mass로 전체 상태 한 번에 조회
    const massData = await getMassStatus(cdp, sessionId, baseUrl);
    if (massData?.error) {
        log.err(`[스캐빈징] 상태 조회 실패: ${massData.error}`);
        return [{ status: 'error', error: massData.error }];
    }
    if (!Array.isArray(massData)) {
        log.err('[스캐빈징] 상태 데이터 형식 오류');
        return [{ status: 'error', error: '데이터 형식 오류' }];
    }

    // 2. 선택된 마을 ID로 필터링 + 스캐빈징 가능 여부 판단
    const selectedIds = new Set(villages.map(v => v.id));
    const results = [];
    const actionable = []; // 실제 스캐빈징할 마을

    for (const mv of massData) {
        if (!selectedIds.has(mv.village_id)) continue;

        const v = villages.find(vv => vv.id === mv.village_id) || { id: mv.village_id, name: mv.village_name };

        // 진행 중인 옵션 하나라도 있으면 스킵 (잠금은 허용)
        const runningOpts = Object.values(mv.options || {}).filter(o => o.scavenging_squad);
        if (runningOpts.length > 0) {
            const locked = Object.values(mv.options || {}).filter(o => o.is_locked).length;
            // 가장 빠른 복귀 시간 기록 (자동 재실행용)
            let earliestReturn = null;
            for (const opt of runningOpts) {
                const rt = opt.scavenging_squad.return_time * 1000;
                if (!earliestReturn || rt < earliestReturn) earliestReturn = rt;
            }
            const minLeft = earliestReturn ? Math.round((earliestReturn - Date.now()) / 60000) : '?';
            results.push({ ...v, status: 'skip', reason: `진행 중 ${runningOpts.length}개 (${minLeft}분 후 복귀)` });
            log.info(`[스캐빈징] ${v.name} — 진행 중 ${runningOpts.length}개, ${minLeft}분 후 복귀`);
            continue;
        }

        // 사용 가능한 옵션 (잠기지 않은 것)
        const availOpts = Object.entries(mv.options || {})
            .filter(([, opt]) => !opt.is_locked)
            .map(([id]) => parseInt(id));

        if (availOpts.length === 0) {
            const locked = Object.values(mv.options || {}).filter(o => o.is_locked).length;
            results.push({ ...v, status: 'skip', reason: `모든 옵션 잠금 (${locked}개)` });
            log.info(`[스캐빈징] ${v.name} — 모든 옵션 잠금`);
            continue;
        }

        // 사용 가능 병력 (창/검/도끼/궁 중 마을별 허용된 것만)
        const rawUnits = mv.unit_counts_home || {};
        const allowedForVillage = options.unitsByVillage?.[mv.village_id];
        const units = filterUnitsByAllowed(rawUnits, allowedForVillage);
        let totalCarry = 0;
        for (const [unit, info] of Object.entries(SCAV_UNITS)) {
            totalCarry += (units[unit] || 0) * info.carry;
        }

        if (totalCarry === 0) {
            results.push({ ...v, status: 'skip', reason: '가용 병력 없음' });
            log.info(`[스캐빈징] ${v.name} — 병력 없음`);
            continue;
        }

        if (totalCarry < MIN_TOTAL_CARRY) {
            results.push({ ...v, status: 'skip', reason: `병력 부족 (carry ${totalCarry} < ${MIN_TOTAL_CARRY})` });
            log.info(`[스캐빈징] ${v.name} — 병력 부족 (carry ${totalCarry})`);
            continue;
        }

        actionable.push({ village: v, massVillage: mv, availOpts, totalCarry });
        log.info(`[스캐빈징] ${v.name} — 열림:${availOpts.length}개, carry:${totalCarry}`);
    }

    // 병력 많은 마을 우선
    actionable.sort((a, b) => b.totalCarry - a.totalCarry);

    log.ok(`[스캐빈징] ${actionable.length}개 마을 실행 예정, ${results.length}개 스킵`);

    // 3. 실행 가능한 마을만 순회 (봇 탭에서 페이지 이동 + 클릭)
    for (let i = 0; i < actionable.length; i++) {
        const { village: v } = actionable[i];
        if (onProgress) onProgress(i, actionable.length, v);

        try {
            const allowedForVillage = options.unitsByVillage?.[v.id];
            const result = await scavengeVillage(cdp, sessionId, baseUrl, v.id, { allowedUnits: allowedForVillage });
            results.push({ ...v, ...result });

            if (result.status === 'ok') {
                const totalTroops = result.squads.reduce((sum, s) =>
                    sum + Object.values(s.troops).reduce((a, b) => a + b, 0), 0);
                log.ok(`[스캐빈징] ${v.name} — ${result.squads.length}개 옵션, ${totalTroops}명`);
            } else if (result.status === 'skip') {
                log.info(`[스캐빈징] ${v.name} — ${result.reason}`);
            } else {
                log.warn(`[스캐빈징] ${v.name} — ${result.error}`);
            }

            // 마을 간 대기
            if (i < actionable.length - 1) {
                await sleep(randInt(2000, 4000));
            }
        } catch (e) {
            results.push({ ...v, status: 'error', error: e.message });
            log.err(`[스캐빈징] ${v.name} — ${e.message}`);
            await sleep(randInt(2000, 4000));
        }
    }

    const okCount = results.filter(r => r.status === 'ok').length;
    const totalSent = results.filter(r => r.status === 'ok')
        .reduce((sum, r) => sum + (r.squads || []).reduce((s2, sq) =>
            s2 + Object.values(sq.troops).reduce((a, b) => a + b, 0), 0), 0);

    // 가장 빠른 복귀 시간 계산 (자동 재실행용)
    // massData에서 진행 중인 모든 옵션의 return_time 수집
    let earliestReturn = null;
    for (const mv of massData) {
        if (!selectedIds.has(mv.village_id)) continue;
        for (const opt of Object.values(mv.options || {})) {
            if (opt.scavenging_squad && opt.scavenging_squad.return_time) {
                const rt = opt.scavenging_squad.return_time * 1000; // unix초 → ms
                if (!earliestReturn || rt < earliestReturn) earliestReturn = rt;
            }
        }
    }

    const nextRunIn = earliestReturn ? Math.max(0, earliestReturn - Date.now()) : null;
    if (nextRunIn) {
        log.info(`[스캐빈징] 가장 빠른 복귀: ${Math.round(nextRunIn / 60000)}분 후`);
    }

    log.ok(`[스캐빈징] 완료: ${okCount}/${villages.length}개 마을, ${totalSent}명 전송`);

    return { results, earliestReturn, nextRunIn };
}

module.exports = { scavengeAll, scavengeVillage, getMassStatus, distributeEqual, calcDuration, carryForDuration, BotProtectionError };
