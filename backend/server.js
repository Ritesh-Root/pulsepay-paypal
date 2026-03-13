require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const enrollRoutes = require('./routes/enroll');
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
const familyRoutes = require('./routes/family');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Make pool available to routes
app.locals.pool = pool;

// Routes
app.use('/api/enroll', enrollRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/family', familyRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, () => {
    console.log(`PulsePay backend running on port ${PORT}`);
});

module.exports = app;
