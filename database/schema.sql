-- PulsePay Database Schema
-- See docs/HOW_IT_WORKS.md. Monetary columns are BIGINT cents (USD).
-- Identifier (wallet UUID) is separated from authenticator (biometric template).
--
-- Payment model: the customer tops up a low-limit wallet with PayPal, then leaves
-- their phone at home. At a merchant's device they are IDENTIFIED by biometric 1:N
-- match (fingerprint, face, or both — their choice), the merchant enters the amount,
-- and the customer types their PIN. The identification lives in a short-lived
-- pay_session consumed by exactly one payment, then the terminal "logs out".
-- The merchant's balance is paid out to their PayPal account (PayPal Payouts).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Customers (and family delegates). phone is NULLABLE only for delegates.
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(16) UNIQUE,                -- E.164 digits, e.g. 14155550123
    emergency_contact VARCHAR(16),                     -- receives the silent distress SOS
    pin_hash        VARCHAR(72),                       -- bcrypt; the knowledge factor typed on the merchant device
    id_method       VARCHAR(12) NOT NULL DEFAULT 'fingerprint'
                    CHECK (id_method IN ('fingerprint','face','both')),  -- customer's choice
    pin_failed_attempts INT NOT NULL DEFAULT 0,
    pin_locked_until TIMESTAMPTZ,                      -- card-style lockout after repeated wrong PINs
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Merchants sign in on their own phone (phone + OTP). Their balance is paid out to
-- the PayPal account registered here; it never comes from a request body.
CREATE TABLE merchants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(16) NOT NULL UNIQUE,
    display_name    VARCHAR(80) NOT NULL,
    paypal_email    VARCHAR(254) NOT NULL UNIQUE,
    is_demo         BOOLEAN NOT NULL DEFAULT FALSE,    -- "Try the demo" shop: payouts always simulated
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE kyc_profiles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    kyc_tier        VARCHAR(8) NOT NULL DEFAULT 'min' CHECK (kyc_tier IN ('min','full')),
    pep_sanctions_status VARCHAR(16) NOT NULL DEFAULT 'clear'
                    CHECK (pep_sanctions_status IN ('clear','review','blocked')),
    verified_via    VARCHAR(16) NOT NULL DEFAULT 'phone_otp',
    limits_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    screened_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_kyc_user ON kyc_profiles(user_id);

-- ---------------------------------------------------------------------------
-- Biometrics (encrypted, cancelable vectors — NOT hashes)
-- ---------------------------------------------------------------------------

CREATE TABLE biometric_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id      UUID NOT NULL REFERENCES users(id),
    template_type   VARCHAR(16) NOT NULL CHECK (template_type IN ('face','fingerprint')),
    purpose         VARCHAR(12) NOT NULL DEFAULT 'auth' CHECK (purpose IN ('auth','distress')),
    protected_vector BYTEA NOT NULL,                   -- AES-256-GCM envelope-encrypted, cancelable-transformed
    enc_iv          BYTEA NOT NULL,
    enc_tag         BYTEA NOT NULL,
    transform_salt  VARCHAR(64) NOT NULL,              -- per-record cancelable-transform seed (rotatable)
    kms_key_ref     VARCHAR(64) NOT NULL DEFAULT 'kms:data-key:v1',
    model_version   VARCHAR(32) NOT NULL DEFAULT 'local-cv:v1',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivated_at  TIMESTAMPTZ
);
CREATE INDEX idx_bio_subject ON biometric_templates(subject_id) WHERE active;
CREATE INDEX idx_bio_type ON biometric_templates(template_type, purpose) WHERE active;

-- ---------------------------------------------------------------------------
-- Wallets & money
-- ---------------------------------------------------------------------------

CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    balance         BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),  -- cached; must equal the ledger-derived balance
    expiry          TIMESTAMPTZ NOT NULL,
    max_lifetime    TIMESTAMPTZ NOT NULL,               -- hard cap; /extend can never exceed this
    extend_count    INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_wallets_expiry ON wallets(expiry) WHERE active;

-- PayPal Checkout orders created for a top-up, so a capture can only fund the flow
-- (and amount) it was created for.
CREATE TABLE paypal_orders (
    order_id        VARCHAR(64) PRIMARY KEY,
    purpose         VARCHAR(12) NOT NULL CHECK (purpose IN ('enrol','topup')),
    phone           VARCHAR(16),                       -- enrolment top-ups
    wallet_id       UUID REFERENCES wallets(id),       -- top-ups of an existing wallet
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    status          VARCHAR(12) NOT NULL DEFAULT 'created' CHECK (status IN ('created','capturing','captured','failed')),
    capture_attempts INT NOT NULL DEFAULT 0,           -- bumped after a decline: the next capture needs a new PayPal-Request-Id
    unconfirmed_at  TIMESTAMPTZ,                       -- a capture got no answer; refunded by the sweep if nobody retries
    simulated       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each PayPal capture that funded a wallet. Closing the wallet refunds against these.
CREATE TABLE wallet_fundings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    paypal_order_id VARCHAR(64) NOT NULL UNIQUE REFERENCES paypal_orders(order_id),
    capture_id      VARCHAR(64) NOT NULL UNIQUE,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    refunded_amount BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
    payer_email     VARCHAR(254),
    simulated       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (refunded_amount <= amount)
);
CREATE INDEX idx_fundings_wallet ON wallet_fundings(wallet_id);

CREATE TABLE delegated_wallets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_wallet_id UUID NOT NULL REFERENCES wallets(id),
    delegate_subject_id UUID NOT NULL REFERENCES users(id),
    spending_cap    BIGINT NOT NULL CHECK (spending_cap >= 0),
    spent_total     BIGINT NOT NULL DEFAULT 0 CHECK (spent_total >= 0),
    per_delegate_expiry TIMESTAMPTZ,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_deleg_parent ON delegated_wallets(parent_wallet_id) WHERE active;

-- Short-lived identification session on a merchant's device. The distress flag
-- lives ONLY here — never in a token or an API response.
CREATE TABLE pay_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    subject_id      UUID NOT NULL REFERENCES users(id),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    is_delegate     BOOLEAN NOT NULL DEFAULT FALSE,
    distress        BOOLEAN NOT NULL DEFAULT FALSE,
    methods_required VARCHAR(12) NOT NULL CHECK (methods_required IN ('fingerprint','face','both')),
    fingerprint_ok  BOOLEAN NOT NULL DEFAULT FALSE,
    face_ok         BOOLEAN NOT NULL DEFAULT FALSE,
    failed_scans    INT NOT NULL DEFAULT 0,
    confidence_score INT,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pay_sessions_merchant ON pay_sessions(merchant_id);

-- Append-only double-entry ledger. Every request_id is a balanced group posted to
-- named accounts:
--   wallet:<id>          customer wallet (liability: credit raises it)
--   pool:paypal          PulsePay's PayPal balance (asset: debit raises it)
--   merchant:<id>        what PulsePay owes a merchant until it is paid out
--   payee:<email>        what PulsePay owes a person a customer sent money to
-- Wallet and merchant balances are derivable from these lines; wallets.balance caches one.
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID REFERENCES wallets(id),           -- the wallet this request concerns, if any
    request_id      VARCHAR(128) NOT NULL,
    account         VARCHAR(300) NOT NULL,
    direction       VARCHAR(6) NOT NULL CHECK (direction IN ('debit','credit')),
    kind            VARCHAR(16) NOT NULL
                    CHECK (kind IN ('fund','payment','send','refund','payout','merchant_refund','invoice')),
    amount          BIGINT NOT NULL CHECK (amount > 0),    -- cents
    balance_after   BIGINT CHECK (balance_after >= 0),     -- wallet lines only
    idempotency_key VARCHAR(160) NOT NULL,
    pay_session_id  UUID,
    external_ref    VARCHAR(128),                          -- PayPal capture / refund / payout item id
    status          VARCHAR(12) NOT NULL DEFAULT 'settled'
                    CHECK (status IN ('reserved','settled','released','pending')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_ledger_idem ON ledger_entries(idempotency_key);
CREATE INDEX idx_ledger_wallet ON ledger_entries(wallet_id);
CREATE INDEX idx_ledger_request ON ledger_entries(request_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account);

-- Immutable journal / human-facing view over the ledger.
CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    merchant_id     UUID REFERENCES merchants(id),
    ledger_entry_id UUID REFERENCES ledger_entries(id),
    kind            VARCHAR(16) NOT NULL DEFAULT 'payment'
                    CHECK (kind IN ('fund','payment','send','refund','merchant_refund')),
    counterparty    VARCHAR(255),                          -- merchant name, PayPal email, "PayPal top-up"
    amount          BIGINT NOT NULL,                       -- cents
    confidence_score INT,
    auth_tier       VARCHAR(32),
    distress_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    refunded        BOOLEAN NOT NULL DEFAULT FALSE,        -- a payment the merchant refunded
    gps_lat         DECIMAL(10,8),
    gps_lng         DECIMAL(11,8),
    status          VARCHAR(16) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tx_wallet ON transactions(wallet_id);
CREATE INDEX idx_tx_merchant ON transactions(merchant_id, created_at DESC);
CREATE UNIQUE INDEX uq_tx_ledger ON transactions(ledger_entry_id);

-- PayPal Payouts to merchants (and to people customers sent money to).
CREATE TABLE payouts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id     UUID REFERENCES merchants(id),
    account         VARCHAR(300) NOT NULL,                 -- ledger account being paid out
    recipient_email VARCHAR(254) NOT NULL,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    sender_batch_id VARCHAR(64) NOT NULL UNIQUE,           -- our idempotency key at PayPal
    payout_batch_id VARCHAR(64),
    payout_item_id  VARCHAR(64),
    status          VARCHAR(16) NOT NULL DEFAULT 'queued', -- queued|PENDING|PROCESSING|SUCCESS|FAILED|UNCLAIMED|RETURNED|BLOCKED|DENIED|...
    source_request  VARCHAR(128),                          -- payment/send request that created the debt
    last_error      TEXT,
    simulated       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payouts_merchant ON payouts(merchant_id, created_at DESC);
CREATE INDEX idx_payouts_open ON payouts(status) WHERE status NOT IN ('SUCCESS','FAILED','RETURNED','BLOCKED','DENIED','REFUNDED','REVERSED');

-- PayPal invoices a merchant created through the AI assistant (paid into the pool,
-- credited to the merchant when PayPal reports them paid).
CREATE TABLE merchant_invoices (
    invoice_id      VARCHAR(64) PRIMARY KEY,
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    recipient_email VARCHAR(254),
    amount          BIGINT,
    status          VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    credited        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every PayPal webhook event, stored once (idempotent by event id).
CREATE TABLE paypal_events (
    event_id        VARCHAR(64) PRIMARY KEY,
    event_type      VARCHAR(80) NOT NULL,
    resource_id     VARCHAR(80),
    verified        BOOLEAN NOT NULL,
    payload         JSONB NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Consent, audit, AML
-- ---------------------------------------------------------------------------

CREATE TABLE consent_records (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id      UUID NOT NULL REFERENCES users(id),
    purpose         VARCHAR(32) NOT NULL
                    CHECK (purpose IN ('wallet_auth','fraud_prevention','kyc','distress','delegate')),
    granted         BOOLEAN NOT NULL,
    channel         VARCHAR(32) NOT NULL DEFAULT 'app',
    language        VARCHAR(16) NOT NULL DEFAULT 'en',
    prev_hash       VARCHAR(64),
    record_hash     VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at    TIMESTAMPTZ
);
CREATE INDEX idx_consent_subject ON consent_records(subject_id);

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor           VARCHAR(64),
    action          VARCHAR(48) NOT NULL,
    subject_user_id UUID,
    resource_ref    VARCHAR(128),
    ip              VARCHAR(64),
    prev_hash       VARCHAR(64),
    record_hash     VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_subject ON audit_log(subject_user_id);

CREATE TABLE aml_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identity_id     UUID NOT NULL REFERENCES users(id),
    rule_id         VARCHAR(32),
    risk_score      INT,
    alert_type      VARCHAR(24)
                    CHECK (alert_type IN ('structuring','velocity','geo','sanctions','wallet_churn','distress','dispute')),
    status          VARCHAR(16) NOT NULL DEFAULT 'open',
    analyst_id      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_aml_identity ON aml_alerts(identity_id);
