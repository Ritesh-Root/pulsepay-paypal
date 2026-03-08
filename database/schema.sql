-- PulsePay Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) UNIQUE NOT NULL,
    aadhaar_verified BOOLEAN DEFAULT FALSE,
    emergency_contact VARCHAR(15),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Wallets table
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    wallet_id_hash VARCHAR(255) UNIQUE NOT NULL,
    fingerprint_hash VARCHAR(255) NOT NULL,
    distress_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(255) NOT NULL,
    balance INTEGER NOT NULL,
    expiry TIMESTAMP NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Delegated wallets table
CREATE TABLE delegated_wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_wallet_id UUID REFERENCES wallets(id),
    delegate_name VARCHAR(255),
    delegate_face_hash VARCHAR(255),
    delegate_fingerprint_hash VARCHAR(255),
    spending_cap INTEGER,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Transactions table
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID REFERENCES wallets(id),
    merchant_upi VARCHAR(255),
    amount INTEGER,
    confidence_score INTEGER,
    auth_tier VARCHAR(50),
    distress_triggered BOOLEAN DEFAULT FALSE,
    gps_lat DECIMAL(10, 8),
    gps_lng DECIMAL(11, 8),
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallets_wallet_id_hash ON wallets(wallet_id_hash);
CREATE INDEX idx_delegated_wallets_parent ON delegated_wallets(parent_wallet_id);
CREATE INDEX idx_transactions_wallet_id ON transactions(wallet_id);
