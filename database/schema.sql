-- PulsePay-SBI Database Schema
-- Re-architected for the SBI hackathon. See ARCHITECTURE.md §5.
-- All tables are India-resident. Monetary columns are BIGINT paise, CHECK >= 0.
-- Identifier (wallet UUID) is separated from authenticator (biometric template).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Users. phone is NULLABLE (the cohort is phone-less). PII encrypted at rest (TDE).
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(15) UNIQUE,                -- nullable: phone-less cohort
    emergency_contact VARCHAR(15),                     -- a registered contact / BC device
    pin_hash        VARCHAR(72),                       -- bcrypt of the normal UPI-PIN-equivalent (knowledge 2nd factor)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_phone ON users(phone);

-- KYC profile replaces the old users.aadhaar_verified boolean.
CREATE TABLE kyc_profiles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    kyc_tier        VARCHAR(8) NOT NULL DEFAULT 'min' CHECK (kyc_tier IN ('min','full')),
    ckyc_id         VARCHAR(64),
    pep_sanctions_status VARCHAR(16) NOT NULL DEFAULT 'clear'
                    CHECK (pep_sanctions_status IN ('clear','review','blocked')),
    verified_via    VARCHAR(16) NOT NULL DEFAULT 'aua_kua',
    limits_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
    screened_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_kyc_user ON kyc_profiles(user_id);

-- Aadhaar token vault — SEGREGATED store. No plaintext Aadhaar; VID/reference only.
-- In production this lives behind a separate KMS key + RBAC / separate DB instance.
CREATE TABLE aadhaar_token_vault (
    token_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    aadhaar_ref_token VARCHAR(255) NOT NULL,           -- tokenized VID/reference, never the number
    aua_txn_id      VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Biometrics (encrypted, cancelable vectors — NOT hashes)
-- ---------------------------------------------------------------------------

-- subject_id references a user OR a delegate (a delegate is its own data principal).
-- template_type: 'fingerprint' (PRIMARY payment factor) or 'face' (step-up above a limit).
-- purpose: 'auth' (normal) or 'distress'. A DISTINCT registered finger (purpose='distress')
--          is the silent distress signal — every finger is biometrically distinct, so it is
--          cleanly separable from the normal payment finger.
CREATE TABLE biometric_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id      UUID NOT NULL REFERENCES users(id),
    template_type   VARCHAR(16) NOT NULL CHECK (template_type IN ('face','fingerprint')),
    purpose         VARCHAR(12) NOT NULL DEFAULT 'auth' CHECK (purpose IN ('auth','distress')),
    protected_vector BYTEA NOT NULL,                   -- AES-256-GCM envelope-encrypted, cancelable-transformed
    enc_iv          BYTEA NOT NULL,                    -- per-record IV
    enc_tag         BYTEA NOT NULL,                    -- GCM auth tag
    transform_salt  VARCHAR(64) NOT NULL,             -- per-record cancelable-transform seed (rotatable)
    kms_key_ref     VARCHAR(64) NOT NULL DEFAULT 'kms:data-key:v1',
    model_version   VARCHAR(32) NOT NULL DEFAULT 'local-onnx:v1',
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
    cbs_account_ref VARCHAR(64),                        -- SBI CBS sub-ledger / shadow account reference
    funding_source  VARCHAR(8) NOT NULL DEFAULT 'sbi_cbs'
                    CHECK (funding_source IN ('sbi_cbs','upi')),   -- crypto removed by construction
    balance         BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),  -- paise, BIGINT
    expiry          TIMESTAMPTZ NOT NULL,
    max_lifetime    TIMESTAMPTZ NOT NULL,               -- hard cap; /extend can never exceed this
    extend_count    INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_wallets_expiry ON wallets(expiry) WHERE active;

CREATE TABLE delegated_wallets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_wallet_id UUID NOT NULL REFERENCES wallets(id),
    delegate_subject_id UUID NOT NULL REFERENCES users(id),  -- delegate is a real user w/ own KYC+consent+template
    spending_cap    BIGINT NOT NULL CHECK (spending_cap >= 0),     -- paise
    spent_total     BIGINT NOT NULL DEFAULT 0 CHECK (spent_total >= 0),
    per_delegate_expiry TIMESTAMPTZ,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_deleg_parent ON delegated_wallets(parent_wallet_id) WHERE active;

-- Append-only, double-entry ledger. Balance is derived; this is the source of truth.
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    entry_type      VARCHAR(12) NOT NULL
                    CHECK (entry_type IN ('credit','reserve','settle','release','refund')),
    amount          BIGINT NOT NULL CHECK (amount >= 0),   -- paise
    balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
    idempotency_key VARCHAR(128) NOT NULL,                 -- one namespace for execute + distress
    auth_assertion_id UUID,
    upi_utr         VARCHAR(64),
    cbs_ref         VARCHAR(64),
    status          VARCHAR(12) NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved','settled','released','failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_ledger_idem ON ledger_entries(idempotency_key);
CREATE INDEX idx_ledger_wallet ON ledger_entries(wallet_id);

-- Immutable journal / human-facing view over the ledger.
CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    ledger_entry_id UUID REFERENCES ledger_entries(id),
    merchant_upi    VARCHAR(255),
    amount          BIGINT NOT NULL,                       -- paise
    confidence_score INT,                                  -- server-derived match score only
    auth_tier       VARCHAR(32),
    distress_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    gps_lat         DECIMAL(10,8),
    gps_lng         DECIMAL(11,8),
    status          VARCHAR(16) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tx_wallet ON transactions(wallet_id);

-- ---------------------------------------------------------------------------
-- Consent, audit, AML, auth bridge
-- ---------------------------------------------------------------------------

-- Append-only, hash-chained consent ledger. References only — NO biometric data.
CREATE TABLE consent_records (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id      UUID NOT NULL REFERENCES users(id),
    purpose         VARCHAR(32) NOT NULL
                    CHECK (purpose IN ('wallet_auth','fraud_prevention','kyc','distress','delegate')),
    granted         BOOLEAN NOT NULL,
    channel         VARCHAR(32) NOT NULL DEFAULT 'branch',
    language        VARCHAR(16) NOT NULL DEFAULT 'en',
    prev_hash       VARCHAR(64),
    record_hash     VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at    TIMESTAMPTZ
);
CREATE INDEX idx_consent_subject ON consent_records(subject_id);

-- Append-only, hash-chained, tamper-evident audit log. NO biometric data (reference-only),
-- so it survives DPDP erasure under a PMLA legal hold.
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

-- AML alerts are keyed to the KYC'd IDENTITY (not the wallet) to catch wallet-churn structuring.
CREATE TABLE aml_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identity_id     UUID NOT NULL REFERENCES users(id),
    rule_id         VARCHAR(32),
    risk_score      INT,
    alert_type      VARCHAR(24)
                    CHECK (alert_type IN ('structuring','velocity','geo','sanctions','wallet_churn','distress')),
    status          VARCHAR(16) NOT NULL DEFAULT 'open',
    analyst_id      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_aml_identity ON aml_alerts(identity_id);

-- Single-use, server-signed bridge from /authenticate to /execute (kills the split-brain).
CREATE TABLE auth_assertions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    subject_id      UUID NOT NULL REFERENCES users(id),
    amount_ceiling  BIGINT NOT NULL,                       -- paise
    merchant        VARCHAR(255),
    tier            VARCHAR(32) NOT NULL,
    nonce           VARCHAR(64) NOT NULL,
    is_delegate     BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at      TIMESTAMPTZ NOT NULL,                  -- ~90s TTL
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_assert_wallet ON auth_assertions(wallet_id);
