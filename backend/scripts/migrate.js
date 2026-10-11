/**
 * Apply database/schema.sql to an empty database (Render Postgres, or any fresh DB),
 * then the idempotent UPGRADES that bring an older database up to the current schema.
 * Safe to run on every start.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Columns added after the first release. Each statement must be safe to repeat.
const UPGRADES = [
    'ALTER TABLE paypal_orders ADD COLUMN IF NOT EXISTS capture_attempts INT NOT NULL DEFAULT 0',
    'ALTER TABLE paypal_orders ADD COLUMN IF NOT EXISTS unconfirmed_at TIMESTAMPTZ',
    'ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE',
];

(async () => {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    const present = await client.query(`SELECT to_regclass('users') AS t`);
    if (present.rows[0].t) {
        console.log('migrate: schema already present');
    } else {
        const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
        await client.query(sql);
        console.log('migrate: schema applied');
    }
    for (const sql of UPGRADES) await client.query(sql);
    await client.end();
})().catch((e) => {
    console.error('migrate failed:', e.message);
    process.exit(1);
});
