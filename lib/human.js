// 인간 행동 패턴: 가우시안 케이던스 + 정지 + 휴식 + 위장
const log = require('./log');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min));
}

// Box-Muller 가우시안
function gaussian(mean, stdDev) {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stdDev;
}

// 동줍 클릭 사이 대기 (280~700ms 가우시안, 평균 380ms)
function nextCadenceMs() {
    let v = gaussian(380, 80);
    if (v < 280) v = 280 + Math.random() * 30;
    if (v > 700) v = 700;
    return v;
}

// 인간 행동 상태 머신 — 액션마다 무엇을 할지 결정
class HumanState {
    constructor() {
        this.actions = 0;
        this.startedAt = Date.now();
        // 다음 짧은 정지 (5~10번 후)
        this.nextShortPauseAt = randInt(5, 11);
        // 다음 긴 정지 (20~40번 후)
        this.nextLongPauseAt = randInt(20, 41);
        // 다음 휴식 (5~15분 후)
        this.nextBreakAt = Date.now() + randInt(5, 16) * 60 * 1000;
        // 다음 위장 행동 (10~25번 후)
        this.nextDistractAt = randInt(10, 26);
    }

    // 액션 1번 끝났을 때 호출 → 다음 동작 결정
    afterAction() {
        this.actions++;

        // 휴식 시간?
        if (Date.now() >= this.nextBreakAt) {
            const breakMs = randInt(60, 301) * 1000; // 1~5분
            // 다음 휴식까지 5~15분
            this.nextBreakAt = Date.now() + breakMs + randInt(5, 16) * 60 * 1000;
            return { type: 'break', ms: breakMs };
        }

        // 긴 정지?
        if (this.actions >= this.nextLongPauseAt) {
            this.nextLongPauseAt = this.actions + randInt(20, 41);
            return { type: 'long', ms: randInt(5000, 20000) };
        }

        // 짧은 정지?
        if (this.actions >= this.nextShortPauseAt) {
            this.nextShortPauseAt = this.actions + randInt(5, 11);
            return { type: 'short', ms: randInt(1000, 3000) };
        }

        // 일반 케이던스
        return { type: 'cadence', ms: nextCadenceMs() };
    }

    // 위장 행동 트리거 여부
    shouldDistract() {
        if (this.actions >= this.nextDistractAt) {
            this.nextDistractAt = this.actions + randInt(10, 26);
            return true;
        }
        return false;
    }

    elapsed() {
        return Math.round((Date.now() - this.startedAt) / 1000);
    }
}

module.exports = { HumanState, nextCadenceMs, gaussian, randInt, sleep };
