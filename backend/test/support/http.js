/** The real Express app (app.js) on a random local port, plus a small fetch helper. */
const { createApp } = require('../../app');
const { generateToken } = require('../../middleware/auth');

async function startApp(pool) {
    const server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    /** call('POST', '/api/payment/pay', body, token) -> { status, body } */
    async function call(method, path, body, token, headers = {}) {
        const r = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    }
    return {
        call,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

const merchantToken = (merchant) => generateToken('merchant', merchant.id);
const customerToken = (user) => generateToken('customer', user.id);

module.exports = { startApp, merchantToken, customerToken };
