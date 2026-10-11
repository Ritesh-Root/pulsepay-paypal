/**
 * Database tests run against a real Postgres named by TEST_DATABASE_URL. Each test
 * file gets its own throwaway schema (created from database/schema.sql and dropped
 * afterwards), so files can run in parallel and never touch another database's tables.
 *
 * Without TEST_DATABASE_URL these suites are reported as skipped.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'TEST_DATABASE_URL not set';

const SCHEMA_SQL = path.join(__dirname, '..', '..', '..', 'database', 'schema.sql');

async function adminQuery(sql) {
    const admin = new Pool({ connectionString: url, max: 1 });
    try { return await admin.query(sql); } finally { await admin.end(); }
}

/**
 * A pool on a brand-new schema. Call close() in after().
 * `sql` replaces database/schema.sql (e.g. an older schema, or '' for an empty database).
 * `connectionString` reaches the same schema from a child process.
 */
async function freshDatabase({ sql } = {}) {
    const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
    try {
        await adminQuery('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    } catch (e) {
        if (e.code !== '23505' && e.code !== '42710') throw e; // another test file created it first
    }
    await adminQuery(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 8 });
    await pool.query((sql ?? fs.readFileSync(SCHEMA_SQL, 'utf8')).replace(/CREATE EXTENSION[^;]*;/g, ''));
    const cs = new URL(url);
    cs.searchParams.set('options', `-c search_path=${schema},public`);
    return {
        pool,
        schema,
        connectionString: cs.toString(),
        async close() {
            await pool.end();
            await adminQuery(`DROP SCHEMA ${schema} CASCADE`);
        },
    };
}

module.exports = { skip, freshDatabase, SCHEMA_SQL };
