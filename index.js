const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(express.json());

// Database variable
let db;

// Initialize database
async function initDatabase() {
  db = await open({
    filename: './credits.db',
    driver: sqlite3.Database
  });
  
  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT,
      credits INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_id ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_created_at ON transactions(created_at);
  `);
  
  console.log('✅ Database initialized');
}

// ============= API ENDPOINTS =============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Credits API'
  });
});

// 1. Check credits for a user
app.get('/api/credits/check/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await db.get(
      'SELECT credits FROM users WHERE user_id = ?',
      [userId]
    );
    
    res.json({
      userId: userId,
      credits: user ? user.credits : 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error checking credits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Use/deduct credits (called by CV generator after use)
app.post('/api/credits/use', async (req, res) => {
  try {
    const { userId, appName, creditsToUse = 1 } = req.body;
    
    if (!userId || !appName) {
      return res.status(400).json({ error: 'userId and appName are required' });
    }
    
    // Check current credits
    const user = await db.get(
      'SELECT credits FROM users WHERE user_id = ?',
      [userId]
    );
    
    const currentCredits = user ? user.credits : 0;
    
    if (currentCredits < creditsToUse) {
      return res.status(402).json({ 
        error: 'Insufficient credits',
        currentCredits: currentCredits,
        required: creditsToUse
      });
    }
    
    // Deduct credits
    await db.run(
      'UPDATE users SET credits = credits - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [creditsToUse, userId]
    );
    
    // Record transaction
    await db.run(
      `INSERT INTO transactions (user_id, amount, type, description) 
       VALUES (?, ?, ?, ?)`,
      [userId, -creditsToUse, 'usage', `Used ${creditsToUse} credit(s) for ${appName}`]
    );
    
    // Get new balance
    const updated = await db.get(
      'SELECT credits FROM users WHERE user_id = ?',
      [userId]
    );
    
    res.json({
      success: true,
      remainingCredits: updated.credits,
      used: creditsToUse,
      appName: appName
    });
  } catch (error) {
    console.error('Error using credits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Add credits (called by your main site after payment)
app.post('/api/credits/add', async (req, res) => {
  try {
    const { userId, email, amount, description, source } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ error: 'userId and amount are required' });
    }
    
    // Add or update user credits
    await db.run(
      `INSERT INTO users (user_id, email, credits) 
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET 
         credits = credits + ?,
         email = COALESCE(?, email),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, email || null, amount, amount, email || null]
    );
    
    // Record transaction
    await db.run(
      `INSERT INTO transactions (user_id, amount, type, description) 
       VALUES (?, ?, ?, ?)`,
      [userId, amount, 'purchase', description || `Added ${amount} credits via ${source || 'main site'}`]
    );
    
    // Get new balance
    const updated = await db.get(
      'SELECT credits FROM users WHERE user_id = ?',
      [userId]
    );
    
    res.json({
      success: true,
      userId: userId,
      newBalance: updated.credits,
      added: amount
    });
  } catch (error) {
    console.error('Error adding credits:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Get transaction history
app.get('/api/credits/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = req.query.limit || 50;
    
    const transactions = await db.all(
      `SELECT * FROM transactions 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [userId, limit]
    );
    
    res.json({
      userId: userId,
      transactions: transactions
    });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Get user stats
app.get('/api/credits/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const stats = await db.get(
      `SELECT 
        u.credits as current_balance,
        SUM(CASE WHEN t.type = 'purchase' THEN t.amount ELSE 0 END) as total_purchased,
        SUM(CASE WHEN t.type = 'usage' THEN ABS(t.amount) ELSE 0 END) as total_used,
        COUNT(CASE WHEN t.type = 'usage' THEN 1 END) as total_actions
       FROM users u
       LEFT JOIN transactions t ON u.user_id = t.user_id
       WHERE u.user_id = ?`,
      [userId]
    );
    
    res.json({
      userId: userId,
      ...stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
async function startServer() {
  await initDatabase();
  
  // IMPORTANT: Bind to 0.0.0.0 for Coolify/Docker
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Credits API running on port ${PORT}`);
    console.log(`📊 Database: SQLite (credits.db)`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`💡 API endpoints ready at /api/credits/*`);
  });
}

startServer();