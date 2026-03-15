require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { authenticateToken } = require('./middleware/auth');

const enrollRoutes = require('./routes/enroll');
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
const familyRoutes = require('./routes/family');
const voiceRoutes = require('./routes/voice');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Make pool available to routes
app.locals.pool = pool;

// Public routes (no auth required)
app.use('/api/enroll', enrollRoutes);
app.use('/api/voice', voiceRoutes);

// Protected routes (JWT required)
app.use('/api/payment', authenticateToken, paymentRoutes);
app.use('/api/wallet', authenticateToken, walletRoutes);
app.use('/api/family', authenticateToken, familyRoutes);

// Health check with DB connectivity
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', uptime: process.uptime() });
    } catch (err) {
        res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`PulsePay backend running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
    console.log('Shutting down gracefully...');
    server.close();
    await pool.end();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
