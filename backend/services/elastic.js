/**
 * Optional Elasticsearch activity index (Elastic Cloud trial or local Elasticsearch).
 *
 *   ELASTIC_URL       e.g. https://my-project.es.us-east-1.aws.elastic.cloud
 *   ELASTIC_API_KEY   an API key with write + read on the index
 *   ELASTIC_INDEX     default pulsepay-activity
 *
 * Every payment, refund and payout is indexed (post-commit, never in the money
 * path) so merchants can search their history in plain words through the assistant,
 * and so Kibana / Elastic Agent Builder can run fraud analytics over it.
 * Documents never contain biometric data, phone numbers or the distress flag.
 */
const INDEX = () => process.env.ELASTIC_INDEX || 'pulsepay-activity';

function configured() {
    return !!(process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY);
}

async function request(method, path, body) {
    const r = await fetch(`${process.env.ELASTIC_URL.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `ApiKey ${process.env.ELASTIC_API_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`elastic ${r.status}: ${data.error?.type || ''}`);
    return data;
}

/** Fire-and-forget index of one activity document. */
function index(doc) {
    if (!configured()) return;
    request('POST', `/${INDEX()}/_doc`, { '@timestamp': new Date().toISOString(), ...doc })
        .catch((e) => console.error('elastic index failed (ignored):', e.message));
}

/** Full-text search over one merchant's activity. */
async function search(merchantId, query, size = 10) {
    const res = await request('POST', `/${INDEX()}/_search`, {
        size: Math.min(Math.max(Number(size) || 10, 1), 25),
        sort: [{ '@timestamp': 'desc' }],
        query: {
            bool: {
                filter: [{ term: { 'merchant_id.keyword': merchantId } }],
                must: query ? [{ simple_query_string: { query: String(query).slice(0, 200), fields: ['*'], default_operator: 'and' } }] : [],
            },
        },
    });
    return (res.hits?.hits || []).map((h) => h._source);
}

module.exports = { configured, index, search };
