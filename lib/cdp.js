// CDP 클라이언트 — 브라우저 레벨 + 탭 세션 부착
const http = require('http');
const WebSocket = require('ws');
const log = require('./log');

class CDP {
    constructor(host = '127.0.0.1', port = 9222) {
        this.host = host;
        this.port = port;
        this.ws = null;
        this.msgId = 0;
        this.pending = new Map();
        this.handlers = [];
    }

    async connect() {
        const version = await this._http('/json/version');
        const wsUrl = version.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('CDP webSocketDebuggerUrl 없음');
        log.debug(`CDP browser ws: ${wsUrl}`);

        this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });

        await new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
            setTimeout(() => reject(new Error('CDP 연결 타임아웃')), 10000);
        });

        this.ws.on('message', (raw) => this._onMessage(raw));
        this.ws.on('close', () => log.warn('CDP 연결 끊김'));
        this.ws.on('error', (err) => log.warn(`CDP ws 에러: ${err.message}`));

        log.ok(`CDP 연결됨 (${this.host}:${this.port})`);
    }

    _http(path, method = 'GET') {
        return new Promise((resolve, reject) => {
            const req = http.request({ host: this.host, port: this.port, path, method }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy(new Error('HTTP 타임아웃')));
            req.end();
        });
    }

    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        // RPC 응답
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                if (msg.error) {
                    p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                    p.res(msg.result);
                }
            }
            return;
        }

        // 이벤트
        for (const h of this.handlers) {
            try { h(msg.method, msg.params, msg.sessionId); }
            catch (e) { log.err(`이벤트 핸들러 에러: ${e.message}`); }
        }
    }

    send(method, params = {}, sessionId = undefined) {
        const id = ++this.msgId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { res: resolve, rej: reject });
            try {
                this.ws.send(JSON.stringify(payload));
            } catch (e) {
                this.pending.delete(id);
                reject(e);
                return;
            }
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP 타임아웃: ${method}`));
                }
            }, 30000);
        });
    }

    on(handler) {
        this.handlers.push(handler);
    }

    // 새 탭 만들기 → 세션 부착 → {targetId, sessionId} 반환
    async createTab(url) {
        const { targetId } = await this.send('Target.createTarget', { url });
        const { sessionId } = await this.send('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        log.ok(`새 탭 생성: ${url.length > 80 ? url.slice(0, 80) + '...' : url}`);
        return { targetId, sessionId };
    }

    async closeTab(targetId) {
        try {
            await this.send('Target.closeTarget', { targetId });
            log.info('탭 닫음');
        } catch (e) {
            log.warn(`탭 닫기 실패: ${e.message}`);
        }
    }

    async listTabs() {
        return await this._http('/json');
    }

    close() {
        try { this.ws.close(); } catch {}
    }
}

module.exports = CDP;
