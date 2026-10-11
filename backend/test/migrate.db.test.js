// scripts/migrate.js, run the way Render and Docker run it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { skip, freshDatabase, SCHEMA_SQL } = require('./support/db');

const MIGRATE = path.join(__dirname, '..', 'scripts', 'migrate.js');
const migrate = (db) => execFileSync('node', [MIGRATE], { env: { ...process.env, DATABASE_URL: db.connectionString }, encoding: 'utf8' });

async function columns(db, table) {
    const r = await db.pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [db.schema, table]
    );
    return r.rows.map((x) => x.column_name);
}

describe('migrate', { skip }, () => {
    it('creates the schema on an empty database', async () => {
        const db = await freshDatabase({ sql: '' });
        try {
            migrate(db);
            assert.ok((await columns(db, 'paypal_orders')).includes('capture_attempts'));
            assert.ok((await columns(db, 'payouts')).includes('sender_batch_id'));
        } finally { await db.close(); }
    });

    it('upgrades a database created before the capture-retry and demo columns existed', async () => {
        const before = fs.readFileSync(SCHEMA_SQL, 'utf8').replace(/^\s*(capture_attempts|unconfirmed_at|is_demo) .*$/gm, '');
        const db = await freshDatabase({ sql: before });
        try {
            assert.ok(!(await columns(db, 'paypal_orders')).includes('capture_attempts'));
            migrate(db);
            migrate(db); // safe to run on every start
            const cols = await columns(db, 'paypal_orders');
            assert.ok(cols.includes('capture_attempts'));
            assert.ok(cols.includes('unconfirmed_at'));
            assert.ok((await columns(db, 'merchants')).includes('is_demo'));
        } finally { await db.close(); }
    });
});
