// 릴레이 공격 큐 — 한 마을이 자기 부대 돌아오면 자기 혼자 같은 곳에 재발사
// 동줍/스캐빈징과 동일 패턴 — overview 페이지 폴링으로 부대 복귀 감지
//
// 기존 코드 재사용:
//   - getReturnsForVillage (lib/farm-auto.js): overview에서 attack/return 명령 추출
//   - gotoPlace, fillForm, clickAttack, waitForConfirm, clickConfirmOk, getAvailableTroops (lib/place.js)
//   - BotLock (lib/bot-lock.js): 다른 큐와 충돌 방지
//   - BotProtectionError 패턴 (lib/farm-auto.js)

const { getReturnsForVillage, BotProtectionError } = require('./farm-auto');
const { gotoPlace, fillForm, clickAttack, waitForConfirm, clickConfirmOk, getAvailableTroops } = require('./place');
const { sleep } = require('./page');
const { randInt } = require('./human');
const { checkBotProtection } = require('./bot-protection');
const log = require('./log');

let nextSessionId = 1;

class RelayQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection;
        this.sessions = new Map(); // sessionId → RelaySession
        this.timer = null;
        this.tickInterval = 5000;
        this.running = false;
        this.stopped = false;
    }

    // 세션 추가 — 즉시 첫 wave 발사 (단, _restored=true면 in_flight 상태로 시작 — overview 폴링이 자연 처리)
    // params: { sourceVillage:{id,name,x,y}, targetX, targetY, troops, maxWaves, _restored?, _currentWave? }
    async addSession(params) {
        const { sourceVillage, targetX, targetY, troops, maxWaves, _restored, _currentWave } = params;
        if (!sourceVillage?.id) throw new Error('sourceVillage 필요');
        if (targetX == null || targetY == null) throw new Error('타겟 좌표 필요');
        if (!troops || Object.values(troops).every(n => !n)) throw new Error('병력 필요');
        const max = parseInt(maxWaves) || 5;

        // 중복 세션 차단 (같은 마을 × 같은 타겟)
        for (const s of this.sessions.values()) {
            if (s.status === 'completed' || s.status === 'stopped') continue;
            if (s.sourceVillageId === sourceVillage.id && s.targetX === targetX && s.targetY === targetY) {
                throw new Error(`이미 진행 중 (#${s.id} ${s.sourceVillageName} → ${targetX}|${targetY})`);
            }
        }

        const id = nextSessionId++;
        const session = {
            id,
            sourceVillageId: sourceVillage.id,
            sourceVillageName: sourceVillage.name,
            targetX: parseInt(targetX),
            targetY: parseInt(targetY),
            troops,
            currentWave: _restored ? (parseInt(_currentWave) || 0) : 0,
            maxWaves: max,
            // 복원 시: in_flight로 시작 → overview 폴링이 부대 복귀 자연 감지
            // 신규: pending → 첫 tick에서 즉시 발사
            status: _restored ? 'in_flight' : 'pending',
            stoppedReason: null,
            lastSentAt: _restored ? Date.now() : null,
            createdAt: Date.now(),
        };
        this.sessions.set(id, session);
        this.stopped = false;
        if (_restored) {
            log.info(`[릴레이 #${id}] 복원: ${sourceVillage.name} → (${targetX}|${targetY}) 웨이브 ${session.currentWave}/${max} (in_flight)`);
        } else {
            log.ok(`[릴레이 #${id}] 추가: ${sourceVillage.name} → (${targetX}|${targetY}) 최대 ${max}웨이브`);
        }

        // 즉시 tick (신규는 발사, 복원은 폴링)
        this._scheduleTick(0);
        return session;
    }

    removeSession(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return false;
        s.status = 'stopped';
        s.stoppedReason = s.stoppedReason || 'manual';
        log.info(`[릴레이 #${sessionId}] 정지 (${s.stoppedReason})`);
        return true;
    }

    stopAll(reason = 'manual') {
        for (const s of this.sessions.values()) {
            if (s.status !== 'completed' && s.status !== 'stopped') {
                s.status = 'stopped';
                s.stoppedReason = reason;
            }
        }
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info(`[릴레이큐] 전체 정지 (${reason})`);
    }

    status() {
        const now = Date.now();
        return {
            running: this.running,
            stopped: this.stopped,
            sessions: [...this.sessions.values()].map(s => ({
                id: s.id,
                sourceVillageId: s.sourceVillageId,
                sourceVillageName: s.sourceVillageName,
                targetX: s.targetX,
                targetY: s.targetY,
                troops: s.troops,
                currentWave: s.currentWave,
                maxWaves: s.maxWaves,
                status: s.status,
                stoppedReason: s.stoppedReason,
                lastSentAt: s.lastSentAt,
                ageSec: s.lastSentAt ? Math.round((now - s.lastSentAt) / 1000) : null,
            })),
        };
    }

    _activeSessions() {
        return [...this.sessions.values()].filter(s => s.status !== 'completed' && s.status !== 'stopped');
    }

    _scheduleTick(delayMs) {
        if (this.stopped || this.timer) return;
        if (this._activeSessions().length === 0) {
            log.info('[릴레이큐] 활성 세션 없음 — tick 중지');
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[릴레이큐] tick 에러: ${e.message}`));
        }, Math.max(0, delayMs ?? this.tickInterval));
    }

    async tick() {
        if (this.stopped || this.running) return;
        const active = this._activeSessions();
        if (active.length === 0) return;

        // 스케줄러 임박 → yield
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[릴레이큐] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후 재시도`);
            this._scheduleTick(wait);
            return;
        }

        // 락 획득
        if (this.botLock) {
            try {
                await this.botLock.acquire('relay');
            } catch (e) {
                log.warn(`[릴레이큐] 락 획득 실패: ${e.message}`);
                this._scheduleTick(this.tickInterval);
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('relay');
            return;
        }

        this.running = true;
        try {
            for (const session of this._activeSessions()) {
                if (this.stopped) break;
                try {
                    await this._processSession(session);
                } catch (e) {
                    if (e instanceof BotProtectionError) {
                        log.err(`🛑 [릴레이큐] 봇 프로텍션 감지: ${e.detail.type} — 전체 정지`);
                        this.stopAll('bot_protection');
                        if (this.onBotProtection) this.onBotProtection(e.detail);
                        break;
                    }
                    log.err(`[릴레이 #${session.id}] 예외: ${e.message}`);
                    session.status = 'stopped';
                    session.stoppedReason = 'error: ' + e.message;
                }
                // 세션 간 자연스러운 간격
                await sleep(randInt(800, 2000));
            }
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('relay');
        }

        if (!this.stopped) this._scheduleTick(this.tickInterval);
    }

    // 세션 한 번 처리 — 상태에 따라 발사 / 복귀 체크
    async _processSession(session) {
        // 0웨이브 (아직 발사 안 함) → 먼저 이미 진행 중인 공격 있나 overview 체크
        if (session.status === 'pending') {
            const stillFlying = await this._checkStillFlying(session);
            if (stillFlying) {
                // 사용자가 미리 보낸 공격이 진행 중 — 릴레이가 이어받음 (wave 1로 카운트)
                session.status = 'in_flight';
                session.currentWave = Math.max(session.currentWave, 1);
                session.lastSentAt = Date.now();
                log.ok(`[릴레이 #${session.id}] 기존 공격 감지 → 릴레이 시작 (웨이브 ${session.currentWave}/${session.maxWaves})`);
                return;
            }
            await this._fireWave(session);
            return;
        }

        // in_flight → overview 폴링
        if (session.status === 'in_flight') {
            const stillFlying = await this._checkStillFlying(session);
            if (stillFlying) {
                // 아직 부대 안 돌아옴
                return;
            }
            log.info(`[릴레이 #${session.id}] 부대 복귀 감지`);

            // 다음 wave 체크 (실제 발사 가능 여부는 _fireWave 안에서 판단 — 10% 임계)
            if (session.currentWave >= session.maxWaves) {
                session.status = 'completed';
                log.ok(`[릴레이 #${session.id}] 완료 (${session.currentWave}/${session.maxWaves} 웨이브)`);
                return;
            }
            await this._fireWave(session);
        }
    }

    // 한 wave 발사 — gotoPlace → fillForm → clickAttack → waitForConfirm → clickConfirmOk
    // 병력 정책: 템플릿 병종만 사용, 각 병종이 템플릿 대비 90% 이상이면 있는 만큼 발사 (손실 허용)
    //           90% 미만이면 손실 큰 것으로 보고 정지
    async _fireWave(session) {
        const waveNum = session.currentWave + 1;
        log.info(`[릴레이 #${session.id}] 웨이브 ${waveNum}/${session.maxWaves} 발사 시작`);
        session.status = 'firing';
        let lastMouse = { x: 500, y: 300 };

        // 1. 광장 이동
        await gotoPlace(this.cdp, this.sessionId, this.baseUrl, session.sourceVillageId);
        await sleep(randInt(400, 900));

        // 봇 프로텍션 체크 (광장 페이지 진입 후)
        const protection = await checkBotProtection(this.cdp, this.sessionId);
        if (protection.detected) throw new BotProtectionError(protection);

        // 2. 보유 병력 vs 템플릿 — 90% 임계로 발사량 결정
        const available = await getAvailableTroops(this.cdp, this.sessionId);
        const sendTroops = {};
        const THRESHOLD = 0.9;
        for (const [unit, expected] of Object.entries(session.troops)) {
            if (!(expected > 0)) continue;
            const actual = available[unit] || 0;
            if (actual < expected * THRESHOLD) {
                session.status = 'stopped';
                session.stoppedReason = `troops_lost (${unit} ${actual}/${expected} < 90%)`;
                log.warn(`[릴레이 #${session.id}] ${unit} 손실 ${actual}/${expected} (<90%) → 정지`);
                return;
            }
            sendTroops[unit] = Math.min(actual, expected);
        }
        const sendStr = Object.entries(sendTroops).map(([u, n]) => `${u}:${n}`).join(' ');
        log.info(`[릴레이 #${session.id}] 발사량: ${sendStr}`);

        // 3. 폼 입력
        await fillForm(this.cdp, this.sessionId, session.targetX, session.targetY, sendTroops);
        await sleep(randInt(700, 1400));

        // 4. Attack 버튼
        lastMouse = await clickAttack(this.cdp, this.sessionId, lastMouse);
        await sleep(randInt(300, 700));

        // 5. confirm 대기
        const confirmBtn = await waitForConfirm(this.cdp, this.sessionId, 15000);
        await sleep(randInt(400, 900));

        // 6. confirm OK 클릭 — 발사
        await clickConfirmOk(this.cdp, this.sessionId, confirmBtn, lastMouse);

        // 7. 발사 후 상태 갱신
        session.lastSentAt = Date.now();
        session.currentWave = waveNum;
        session.status = 'in_flight';
        log.ok(`[릴레이 #${session.id}] 웨이브 ${waveNum}/${session.maxWaves} 발사 완료`);

        // 발사 직후엔 폴링 무의미 — 다음 tick 늦게
        await sleep(randInt(1500, 3000));
    }

    // 우리 명령 (attack 또는 return)이 overview에 아직 있나?
    // 라벨 텍스트에 "(X|Y)" 포함된 것 매칭
    async _checkStillFlying(session) {
        const r = await getReturnsForVillage(this.cdp, this.sessionId, this.baseUrl, session.sourceVillageId);
        if (!r?.ok) {
            log.warn(`[릴레이 #${session.id}] overview 조회 실패 — 다음 tick 재시도`);
            return true; // 안전하게 대기
        }
        const coordStr = `(${session.targetX}|${session.targetY})`;
        const ours = r.returns.filter(ret => (ret.label || '').includes(coordStr));
        return ours.length > 0;
    }

}

module.exports = RelayQueue;
