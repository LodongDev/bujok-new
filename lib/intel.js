// 인커밍 인텔리전스 — 노블트레인/페이크/일반 자동 분류
const log = require('./log');

// 인커밍 목록 → 분류된 그룹으로 변환
function analyzeIncomings(incomings) {
    const groups = {
        nobleTrains: [],   // 노블트레인 (가장 위험)
        bigAttacks: [],    // 대규모 공격
        smallAttacks: [],  // 소규모 공격
        fakes: [],         // 페이크
        scouts: [],        // 정찰
        supports: [],      // 아군 원군
        unknown: [],       // 불명
    };

    // 1단계: 기본 분류
    const classified = incomings.map(inc => ({
        ...inc,
        category: classifySingle(inc),
    }));

    // 2단계: 노블트레인 감지 (같은 출발지 → 같은 타겟, 50ms 이내 연속)
    const trains = detectNobleTrains(classified);
    const trainCmdIds = new Set();
    for (const train of trains) {
        groups.nobleTrains.push(train);
        for (const wave of train.waves) trainCmdIds.add(wave.commandId);
    }

    // 3단계: 나머지 분류
    for (const inc of classified) {
        if (trainCmdIds.has(inc.commandId)) continue; // 이미 노블트레인에 포함
        switch (inc.category) {
            case 'fake': groups.fakes.push(inc); break;
            case 'scout': groups.scouts.push(inc); break;
            case 'support': groups.supports.push(inc); break;
            case 'big': groups.bigAttacks.push(inc); break;
            case 'small': groups.smallAttacks.push(inc); break;
            default: groups.unknown.push(inc); break;
        }
    }

    return groups;
}

// 개별 인커밍 기본 분류
function classifySingle(inc) {
    if (inc.type === 'support') return 'support';

    const units = inc.units || {};
    const totalUnits = Object.values(units).reduce((a, b) => a + b, 0);

    // 유닛 정보 없으면 불명
    if (totalUnits === 0 && Object.keys(units).length === 0) return 'unknown';

    // 1마리짜리 = 페이크
    if (totalUnits <= 1) return 'fake';

    // spy만 = 정찰
    if (Object.keys(units).length === 1 && units.spy) return 'scout';
    if (totalUnits <= 5 && units.spy && units.spy === totalUnits) return 'scout';

    // snob 포함 = 노블 (단독은 여기서, 트레인은 2단계에서)
    if (units.snob && units.snob > 0) return 'noble';

    // 대규모 (200+ 유닛)
    if (totalUnits >= 200) return 'big';

    // 소규모
    if (totalUnits < 50) return 'small';

    return 'medium';
}

// 노블트레인 감지 — 같은 출발지 → 같은 타겟, 100ms 이내 연속 도착
function detectNobleTrains(classified) {
    const trains = [];

    // 출발지+타겟 기준으로 그룹핑
    const groups = new Map();
    for (const inc of classified) {
        if (inc.type === 'support') continue;
        const key = `${inc.sourceVillageId}_${inc.targetVillageId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(inc);
    }

    for (const [key, group] of groups) {
        if (group.length < 2) continue;

        // 도착시간 순 정렬
        group.sort((a, b) => a.arrivalTimestamp - b.arrivalTimestamp);

        // 연속 100ms 이내 도착하는 웨이브 클러스터 찾기
        let cluster = [group[0]];
        for (let i = 1; i < group.length; i++) {
            const gap = group[i].arrivalTimestamp - group[i - 1].arrivalTimestamp;
            if (gap <= 100) {
                cluster.push(group[i]);
            } else {
                if (cluster.length >= 2) emitTrain(cluster);
                cluster = [group[i]];
            }
        }
        if (cluster.length >= 2) emitTrain(cluster);
    }

    function emitTrain(waves) {
        // 노블 포함 여부 확인
        const hasNoble = waves.some(w => w.units?.snob > 0);
        // 큰 유닛 수의 웨이브 = 클리어
        const clearWave = waves.reduce((best, w) => {
            const total = Object.values(w.units || {}).reduce((a, b) => a + b, 0);
            const bestTotal = Object.values(best.units || {}).reduce((a, b) => a + b, 0);
            return total > bestTotal ? w : best;
        }, waves[0]);

        trains.push({
            type: hasNoble ? 'noble_train' : 'multi_wave',
            sourceVillageId: waves[0].sourceVillageId,
            targetVillageId: waves[0].targetVillageId,
            waves,
            clearWave,
            hasNoble,
            arrivalTimestamp: waves[0].arrivalTimestamp,
            arrivalDate: waves[0].arrivalDate,
            // 스나이핑 추천: 클리어 직후
            recommendedSnipeTime: clearWave.arrivalTimestamp + 5,
        });
    }

    return trains;
}

// 표시용 유닛 문자열
function unitStr(units) {
    if (!units || Object.keys(units).length === 0) return '?';
    return Object.entries(units).filter(([, c]) => c > 0).map(([u, c]) => `${u}:${c}`).join(' ');
}

// 남은 시간 표시
function remainStr(timestamp) {
    const ms = timestamp - Date.now();
    if (ms <= 0) return '이미 도착';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}초 후`;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    if (min < 60) return `${min}분 ${s}초 후`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}시간 ${m}분 후`;
}

module.exports = { analyzeIncomings, classifySingle, detectNobleTrains, unitStr, remainStr };
