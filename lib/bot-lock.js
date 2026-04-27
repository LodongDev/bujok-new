// 봇 탭 공유 뮤텍스 — 동시 요청 방지
// 모든 큐(스케줄러/스캐빈징/시장)가 이 락을 거쳐 순차 실행
const log = require('./log');

class BotLock {
    constructor() {
        this.holder = null;       // 현재 락을 쥔 작업명
        this.waiters = [];        // [{resolve, name}] FIFO 큐
    }

    // 락 획득 (대기 가능)
    async acquire(name, { priority = 0, timeoutMs = 10 * 60 * 1000 } = {}) {
        if (!this.holder) {
            this.holder = name;
            return true;
        }
        log.info(`[락] ${name} 대기 (현재: ${this.holder})`);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, name, priority };
            // 우선순위 정렬 (높은 priority가 앞으로)
            const idx = this.waiters.findIndex(w => w.priority < priority);
            if (idx === -1) this.waiters.push(waiter);
            else this.waiters.splice(idx, 0, waiter);

            const timer = setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Error(`락 대기 타임아웃: ${name}`));
            }, timeoutMs);
            waiter.timer = timer;
        });
    }

    // 락 해제 — 다음 대기자 깨움
    release(name) {
        if (this.holder !== name) {
            log.warn(`[락] 해제 시도 불일치: 요청=${name}, 현재=${this.holder}`);
            return;
        }
        this.holder = null;
        const next = this.waiters.shift();
        if (next) {
            if (next.timer) clearTimeout(next.timer);
            this.holder = next.name;
            next.resolve(true);
        }
    }

    // 현재 상태
    status() {
        return { holder: this.holder, waiting: this.waiters.map(w => w.name) };
    }

    // 누가 쥐고 있는지
    isHeld() {
        return !!this.holder;
    }

    heldBy() {
        return this.holder;
    }

    // 편의 함수: 락 잡고 작업 → 자동 해제
    async withLock(name, fn, opts = {}) {
        await this.acquire(name, opts);
        try {
            return await fn();
        } finally {
            this.release(name);
        }
    }
}

module.exports = BotLock;
