// Runtime.evaluate 헬퍼 — 페이지 컨텍스트에서 JS 실행
async function evaluate(cdp, sessionId, expression, opts = {}) {
    const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: opts.awaitPromise !== false,
        returnByValue: true,
        userGesture: true,
    }, sessionId);

    if (result.exceptionDetails) {
        const text = result.exceptionDetails.text
            || result.exceptionDetails.exception?.description
            || JSON.stringify(result.exceptionDetails);
        throw new Error(`JS 에러: ${text}`);
    }
    return result.result?.value;
}

module.exports = { evaluate };
