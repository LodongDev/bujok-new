// 단순 색상 로거 + 파일 저장
const fs = require('fs');
const path = require('path');

const C = {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
};

const LOG_FILE = path.join(__dirname, '..', 'bujok.log');
// 시작 시 새 세션 마커
try { fs.appendFileSync(LOG_FILE, `\n=== 세션 시작 ${new Date().toISOString()} ===\n`); } catch {}

function ts() {
    return new Date().toISOString().slice(11, 23);
}

function _log(level, color, msg) {
    const line = `${ts()} ${level.padEnd(5)} ${msg}`;
    console.log(`${C.gray}${ts()}${C.reset} ${color}${level.padEnd(5)}${C.reset} ${msg}`);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

module.exports = {
    info: (m) => _log('INFO', C.cyan, m),
    ok: (m) => _log('OK', C.green, m),
    warn: (m) => _log('WARN', C.yellow, m),
    err: (m) => _log('ERR', C.red, m),
    human: (m) => _log('HUMAN', C.magenta, m),
    debug: (m) => process.env.DEBUG && _log('DEBUG', C.gray, m),
};
