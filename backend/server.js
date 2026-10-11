require('dotenv').config();
const { Pool } = require('pg');
const kms = require('./services/kms');
const { bootProblems } = require('./services/boot');
const { createApp } = require('./app');
const payouts = require('./services/payouts');
const funding = require('./services/funding');
const rails = require('./services/rails');

// --- Fail-closed boot checks (services/boot.js) ------------------------------
(function bootGuards() {
    const errors = bootProblems(process.env);
    try { kms.assertAvailable(); } catch (e) { errors.push(e.message); }
    if (errors.length) {
        console.error('FATAL: refusing to start (fail-closed):\n - ' + errors.join('\n - '));
        process.exit(1);
    }
})();

const PORT = process.env.PORT || 5000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(pool);

const server = app.listen(PORT, () => {
    console.log(`PulsePay backend running on port ${PORT} (money rails: ${rails.mode()})`);
});
payouts.startReconciler(pool);
funding.startSweeper(pool);

const shutdown = async () => {
    console.log('Shutting down gracefully...');
    server.close();
    await pool.end();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
