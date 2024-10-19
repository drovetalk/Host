//New Index.js
const express = require('express');
const bodyParser = require('body-parser');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const mysql = require('mysql2/promise');
const session = require('express-session');
const fetch = require('node-fetch');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();
require('dotenv').config();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));
app.use(session({
    secret: '3800380',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

let sock;
let globalUserPhoneNumber = null;
app.set('view engine', 'ejs');


const dbConfig = {
    host: 'sv82.ifastnet.com',
    user: 'crossgig_talkdrovetestuser',
    password: 'talkdrovetestuser',
    database: 'crossgig_talkdrovetest',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

async function initDatabase() {
    try {
        const connection = await pool.getConnection();

        // Users table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone_number VARCHAR(20) UNIQUE NOT NULL,
                is_verified BOOLEAN DEFAULT FALSE,
                coins INT DEFAULT 0,
                is_admin BOOLEAN DEFAULT FALSE
            )
        `);

        // Bots table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS bots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                repo_url VARCHAR(255) NOT NULL,
                deployment_cost INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Bot environment variables table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS bot_env_vars (
                id INT AUTO_INCREMENT PRIMARY KEY,
                bot_id INT,
                var_name VARCHAR(255) NOT NULL,
                var_description TEXT,
                FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
            )
        `);
        await connection.query(`
            CREATE TABLE IF NOT EXISTS deployed_apps (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                bot_id INT,
                app_name VARCHAR(255) NOT NULL,
                heroku_app_name VARCHAR(255) NOT NULL,
                deployed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL
            )
        `);
// Add this after the CREATE TABLE query
await connection.query(`
    ALTER TABLE deployed_apps
    ADD COLUMN IF NOT EXISTS bot_id INT,
    ADD FOREIGN KEY IF NOT EXISTS (bot_id) REFERENCES bots(id) ON DELETE SET NULL
`);
        // Add columns if they don't exist
        await connection.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS referrer_id INT,
            ADD FOREIGN KEY IF NOT EXISTS (referrer_id) REFERENCES users(id)
        `);
      // Add columns if they don't exist
      await connection.query(`
       CREATE TABLE IF NOT EXISTS deployment_env_vars (
    id INT AUTO_INCREMENT PRIMARY KEY,
    deployment_id INT NOT NULL,
    var_name VARCHAR(255) NOT NULL,
    var_value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deployment_id) REFERENCES deployed_apps(id) ON DELETE CASCADE
);
    `);
        await connection.query(`
            ALTER TABLE deployed_apps 
            ADD COLUMN IF NOT EXISTS cost INT DEFAULT 10
        `);
await connection.query(`
           CREATE TABLE IF NOT EXISTS deployments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bot_id INT NOT NULL,
    app_url VARCHAR(255) NOT NULL,
    deployed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending',
    FOREIGN KEY (bot_id) REFERENCES bots(id)
);
        `);
        // Invites table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS invites (
                id INT AUTO_INCREMENT PRIMARY KEY,
                inviter_id INT,
                invite_code VARCHAR(20) UNIQUE NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Coin transactions table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS coin_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_phone VARCHAR(20),
                recipient_phone VARCHAR(20),
                amount INT NOT NULL,
                transaction_type ENUM('transfer', 'deposit', 'deployment') DEFAULT 'transfer',
                transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_phone) REFERENCES users(phone_number) ON DELETE SET NULL,
                FOREIGN KEY (recipient_phone) REFERENCES users(phone_number) ON DELETE SET NULL
            )
        `);

        connection.release();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

async function connectToWA() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('Using WA version ' + version.join('.') + ', isLatest: ' + isLatest);

    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'session/'));

    sock = makeWASocket({
        logger: P({ level: 'fatal' }).child({ level: 'fatal' }),
        printQRInTerminal: true,
        auth: state,
        msgRetryCounterCache: msgRetryCounterCache
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            if (lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut) {
                connectToWA();
            }
        } else if (connection === 'open') {
            console.log('Bot connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

Promise.all([connectToWA(), initDatabase()])
    .then(() => console.log('Bot connected and database initialized'))
    .catch(err => console.log('Error during initialization:', err));
// In-memory storage for verification codes
const verificationCodes = {};

// Middleware to check if user is logged in
function isLoggedIn(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}
// Add these middleware functions at the top of your routes
const checkUserCoins = async (req, res, next) => {
    try {
        const [userRows] = await pool.query(
            'SELECT coins FROM users WHERE phone_number = ?', 
            [req.session.user.phoneNumber]
        );
        
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        req.userCoins = userRows[0].coins;
        next();
    } catch (error) {
        console.error('Error checking user coins:', error);
        res.status(500).json({ error: 'Failed to check user coins' });
    }
};

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.isAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'Access denied' });
    }
}
// Serve static files
app.use(express.static('public'));

// Main routes
app.get('/', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Separate route for login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Separate route for registration page
app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});



app.post('/prepare-deployment', async (req, res) => {
    try {
        const botId = req.body.botId;

        // Fetch bot details
        const [botRows] = await pool.query('SELECT * FROM bots WHERE id = ?', [botId]);
        
        if (botRows.length === 0) {
            return res.status(404).send('Bot not found');
        }

        const bot = botRows[0];

        // Fetch environment variables for the selected bot
        const [envVarRows] = await pool.query('SELECT * FROM bot_env_vars WHERE bot_id = ?', [botId]);
        
        bot.envVars = envVarRows;

        res.render('deploy-bot', { bot });
    } catch (error) {
        console.error('Error preparing deployment:', error);
        res.status(500).send('An error occurred while preparing the deployment');
    }
});





app.get('/select-bot', isLoggedIn, async (req, res) => {
    try {
        const [bots] = await pool.query('SELECT * FROM bots');
        res.render('select-bot', { bots });
    } catch (error) {
        console.error('Error fetching bots:', error);
        res.status(500).json({ error: 'An error occurred while fetching bots' });
    }
});
// Admin panel main page
app.get('/admin',  (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/invite', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'invite', 'invite.html'));
});
// Check if phone number exists in database
app.post('/check-phone', async (req, res) => {
    const { phoneNumber } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE phone_number = ?', [phoneNumber]);
        if (rows.length > 0) {
            res.json({ success: true, message: 'Phone number exists.' });
        } else {
            res.status(404).json({ success: false, message: 'User not found. Please register first.' });
        }
    } catch (error) {
        console.error('Error checking phone number:', error);
        res.status(500).json({ success: false, message: 'An error occurred while checking the phone number.' });
    }
});

// Send verification code (login/signup)
app.post('/send-code', async (req, res) => {
    const { phoneNumber, isRegistering } = req.body;
    try {
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes[phoneNumber] = verificationCode;

        const message = {
            text: `Your verification code is: ${verificationCode}`,
            footer: 'Tap the button below to copy the code',
            templateButtons: [
                {
                    index: 1,
                    quickReplyButton: {
                        displayText: `Copy Code: ${verificationCode}`,
                        id: 'copy-code',
                    },
                },
            ],
        };
        await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, message);
        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('Error sending verification code:', error);
        res.status(500).json({ success: false, message: 'An error occurred while sending the verification code.' });
    }
});


// Verify code (common for both login and registration)
app.post('/verify', async (req, res) => {
    const { phoneNumber, code, isRegistering } = req.body;

    if (verificationCodes[phoneNumber] === code) {
        return res.status(400).json({ error: 'Invalid verification code' });
    }

    try {
        delete verificationCodes[phoneNumber]; // Remove code after successful verification

        if (isRegistering) {
            // Register a new user if they are registering
            await pool.query('INSERT INTO users (phone_number, is_verified) VALUES (?, TRUE)', [phoneNumber]);
            req.session.user = { phoneNumber, isVerified: true }; // Set session for the new user
            res.json({ message: 'Registration successful' });
        } else {
            // If logging in, just set session and return success
            req.session.user = { phoneNumber, isVerified: true };
            res.json({ message: 'Login successful' });
        }
    } catch (error) {
        console.error('Error during verification:', error);
        res.status(500).json({ error: 'An error occurred during verification' });
    }
});


//All apps
app.get('/apps', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [apps] = await pool.query(`
            SELECT * 
            FROM deployed_apps 
            WHERE user_id = ?
        `, [userId]);
        res.render('apps', { apps });
    } catch (error) {
        console.error('Error fetching user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});
// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/login');
    });
});

// Check login status route
app.get('/check-login', (req, res) => {
    if (req.session.user) {
        res.status(200).json({ loggedIn: true });
    } else {
        res.status(401).json({ loggedIn: false });
    }
});



//Select bot route 
app.get('/select-bot', isLoggedIn, async (req, res) => {
    try {
        const [bots] = await pool.query('SELECT * FROM bots');
        res.render('select-bot', { bots });
    } catch (error) {
        console.error('Error fetching bots:', error);
        res.status(500).json({ error: 'An error occurred while fetching bots' });
    }
});


// Modify the /user-coins route
app.get('/user-coins', isLoggedIn, async (req, res) => {
    try {
        // Query the user's coins
        const [rows] = await pool.query('SELECT coins FROM users WHERE phone_number = ?', [req.session.user.phoneNumber]);

        if (rows.length > 0) {
            res.json({ coins: rows[0].coins });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error('Error fetching user coins:', error);
        res.status(500).json({ error: 'An error occurred while fetching user coins' });
    }
});
app.post('/claim-coins', isLoggedIn, async (req, res) => {
    try {
        const dailyCoins = 10; // Number of coins to be claimed daily
        await pool.query('UPDATE users SET coins = coins + ? WHERE phone_number = ?', [dailyCoins, req.session.user.phoneNumber]);
        
        // Send a success response to the client
        res.status(200).json({ message: "10 coins claimed successfully" });
    } catch (error) {
        console.error('Error claiming coins:', error);
        res.status(500).json({ error: 'An error occurred while claiming coins' });
    }
});


// Updated bot deployment details route
app.get('/bot-deployment/:botId', isLoggedIn, async (req, res) => {
    const botId = req.params.botId;
    
    try {
        // Fetch bot details with a single query
        const [rows] = await pool.query(`
            SELECT 
                b.*,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'var_name', bev.var_name,
                        'is_required', bev.is_required,
                        'var_description', bev.var_description
                    )
                ) as env_vars
            FROM bots b
            LEFT JOIN bot_env_vars bev ON b.id = bev.bot_id
            WHERE b.id = ?
            GROUP BY b.id
        `, [botId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Bot not found' });
        }

        const bot = rows[0];
        const envVars = JSON.parse(bot.env_vars);
        delete bot.env_vars;

        // Fetch user's coins
        const [userRows] = await pool.query(
            'SELECT coins FROM users WHERE phone_number = ?',
            [req.session.user.phoneNumber]
        );

        // Check if user can afford deployment
        const canDeploy = userRows[0].coins >= bot.deployment_cost;

        res.json({
            bot,
            envVars,
            userCoins: userRows[0].coins,
            canDeploy
        });

    } catch (error) {
        console.error('Error fetching bot deployment details:', error);
        res.status(500).json({ error: 'Failed to fetch bot deployment details' });
    }
});
// Route to get deployment details
app.get('/deployment/:id', isLoggedIn, async (req, res) => {
    try {
        const [deployment] = await pool.query(`
            SELECT 
                d.*, 
                b.name as bot_name,
                b.repo_url,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'var_name', dev.var_name,
                        'var_value', dev.var_value
                    )
                ) as env_vars
            FROM deployed_apps d
            JOIN bots b ON d.bot_id = b.id
            LEFT JOIN deployment_env_vars dev ON d.id = dev.deployment_id
            WHERE d.id = ?
            GROUP BY d.id
        `, [req.params.id]);

        if (deployment.length === 0) {
            return res.status(404).json({ error: 'Deployment not found' });
        }

        res.json(deployment[0]);
    } catch (error) {
        console.error('Error fetching deployment:', error);
        res.status(500).json({ error: 'Failed to fetch deployment details' });
    }
});
// Cron job to delete apps if users have no coins
cron.schedule('0 0 * * *', async () => {
    try {
        const [users] = await pool.query('SELECT id, phone_number, coins FROM users');
        for (const user of users) {
            // Get the number of active apps for the user
            const [apps] = await pool.query('SELECT COUNT(*) as appCount FROM deployed_apps WHERE user_id = ?', [user.id]);
            const activeApps = apps[0].appCount;

            if (activeApps > 0) {
                // Deduct coins based on the number of active apps
                const coinsToDeduct = Math.min(user.coins, activeApps);
                await pool.query('UPDATE users SET coins = coins - ? WHERE id = ?', [coinsToDeduct, user.id]);
                console.log(`Deducted ${coinsToDeduct} coins from user ${user.phone_number} for ${activeApps} active apps`);

                // If user ran out of coins, delete all their apps
                if (user.coins - coinsToDeduct <= 0) {
                    const [appsToDelete] = await pool.query('SELECT heroku_app_name FROM deployed_apps WHERE user_id = ?', [user.id]);
                    for (const app of appsToDelete) {
                        await deleteApp(app.heroku_app_name);
                        console.log(`Deleted app ${app.heroku_app_name} due to insufficient coins`);
                    }
                    await pool.query('DELETE FROM deployed_apps WHERE user_id = ?', [user.id]);
                    console.log(`Removed all apps for user ${user.phone_number} due to insufficient coins`);
                }
            }
        }
        console.log('Daily coin deduction and app cleanup completed');
    } catch (error) {
        console.error('Error in daily coin deduction and app cleanup:', error);
    }
});
// Showing all user apps
// app.get('/all-userapps', async (req, res) => {
//     try {
//         const [apps] = await pool.query(`
//             SELECT users.phone_number, deployed_apps.app_name, deployed_apps.deployed_at 
//             FROM deployed_apps 
//             JOIN users ON deployed_apps.user_id = users.id
//         `);
//         res.json(apps);
//     } catch (error) {
//         console.error('Error fetching all user apps:', error);
//         res.status(500).json({ error: 'An error occurred while fetching user apps' });
//     }
// });


// Modified route to get user's apps
app.get('/user-apps', isLoggedIn, async (req, res) => {
    try {
        const phoneNumber = req.session.user.phoneNumber;
        const [userRows] = await pool.query('SELECT id FROM users WHERE phone_number = ?', [phoneNumber]);
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [appRows] = await pool.query('SELECT app_name, deployed_at FROM deployed_apps WHERE user_id = ?', [userRows[0].id]);
        res.json(appRows);
    } catch (error) {
        console.error('Error fetching user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});


// Function to delete an app from Heroku and MySQL
const deleteApp = async (appName) => {
    try {
        const apiKeys = await fetchApiKeys();
        let appDeleted = false;
        let lastError = null;

        // Try deleting the app from Heroku
        for (const apiKey of apiKeys) {
            try {
                const response = await fetch(`https://api.heroku.com/apps/${appName}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/vnd.heroku+json; version=3'
                    }
                });

                if (response.ok) {
                    appDeleted = true;
                    console.log(`App ${appName} deleted from Heroku`);
                    break;
                } else {
                    const errorData = await response.json();
                    lastError = `Heroku API Error: ${errorData.message || response.statusText}`;
                }
            } catch (error) {
                console.error(`Error deleting app with API key: ${apiKey}`, error);
                lastError = error.message;
            }
        }

        // Regardless of whether the app was deleted from Heroku or not, delete it from MySQL
        const [result] = await pool.query('DELETE FROM deployed_apps WHERE app_name = ?', [appName]);

        if (result.affectedRows === 0) {
            console.warn(`App ${appName} not found in the database`);
        } else {
            console.log(`App ${appName} deleted from the database`);
        }

        // Return a response based on the Heroku deletion result
        if (appDeleted) {
            return { success: true, message: `App ${appName} deleted successfully from Heroku and MySQL` };
        } else {
            console.warn(`App ${appName} could not be deleted from Heroku but was deleted from MySQL`);
            return { success: true, message: `App ${appName} deleted from MySQL, but not found on Heroku: ${lastError}` };
        }
    } catch (error) {
        console.error('Error deleting app:', error);
        return { success: false, message: error.message };
    }
};

// DELETE route to delete an app by app name
app.delete('/delete-app/:appName', async (req, res) => {
    const { appName } = req.params;

    try {
        const result = await deleteApp(appName);

        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('Error in delete app route:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// New function to get user's apps
async function getUserApps(phoneNumber) {
    const apiKeys = await fetchApiKeys();
    const userApps = [];

    for (const apiKey of apiKeys) {
        try {
            const response = await fetch('https://api.heroku.com/apps', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch apps: ${response.statusText}`);
            }

            const apps = await response.json();
            const filteredApps = apps.filter(app => app.name.startsWith(`free${phoneNumber}`));
            userApps.push(...filteredApps);
        } catch (error) {
            console.error(`Error fetching apps with API key: ${apiKey} - ${error.message}`);
        }
    }

    return userApps;
}

// Get all users
app.get('/admin/users',  async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM users');
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'An error occurred while fetching users' });
    }
});

// Update user coins
app.put('/admin/users/:id/coins',  async (req, res) => {
    const { id } = req.params;
    const { coins } = req.body;
    try {
        await pool.query('UPDATE users SET coins = ? WHERE id = ?', [coins, id]);
        res.json({ message: 'User coins updated successfully' });
    } catch (error) {
        console.error('Error updating user coins:', error);
        res.status(500).json({ error: 'An error occurred while updating user coins' });
    }
});

// Delete user
app.delete('/admin/users/:id',  async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'An error occurred while deleting the user' });
    }
});


// Add new bot
app.post('/admin/bots',  async (req, res) => {
    const { name, repoUrl, deploymentCost, envVars } = req.body;
    try {
        const [result] = await pool.query('INSERT INTO bots (name, repo_url, deployment_cost) VALUES (?, ?, ?)', [name, repoUrl, deploymentCost]);
        const botId = result.insertId;

        for (const envVar of envVars) {
            await pool.query('INSERT INTO bot_env_vars (bot_id, var_name, var_description) VALUES (?, ?, ?)', [botId, envVar.name, envVar.description]);
        }

        res.json({ message: 'Bot added successfully', botId });
    } catch (error) {
        console.error('Error adding bot:', error);
        res.status(500).json({ error: 'An error occurred while adding the bot' });
    }
});

// Delete bot
app.delete('/admin/bots/:id',  async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM bot_env_vars WHERE bot_id = ?', [id]);
        await pool.query('DELETE FROM bots WHERE id = ?', [id]);
        res.json({ message: 'Bot deleted successfully' });
    } catch (error) {
        console.error('Error deleting bot:', error);
        res.status(500).json({ error: 'An error occurred while deleting the bot' });
    }
});


// All deployment code goes here
const API_KEYS_URL = 'https://talkdrove.com/api/apis.json';

async function fetchApiKeys() {
    try {
        const response = await fetch(API_KEYS_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch API keys: ${response.statusText}`);
        }
        const data = await response.json();
        return data.apiKeys;
    } catch (error) {
        console.error(error);
        return [];
    }
}

async function isAppNameTaken(appName, apiKey) {
    const response = await fetch(`https://api.heroku.com/apps/${appName}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/vnd.heroku+json; version=3'
        }
    });

    if (response.status === 404) {
        return false;
    }
    
    if (response.ok) {
        return true;
    }

    throw new Error(`Failed to check app name: ${response.statusText}`);
}
// Function to get user ID by phone number
async function getUserIdByPhoneNumber(phoneNumber) {
    try {
        const connection = await pool.getConnection();
        const [user] = await connection.query('SELECT id FROM users WHERE phone_number = ?', [phoneNumber]);
        connection.release();

        if (user.length > 0) {
            return user[0].id;  // Return the user's ID
        } else {
            throw new Error('User not found');
        }
    } catch (error) {
        console.error('Error getting user ID:', error);
        throw error;
    }
}

function generateRandomAppName() {
    return 'app-' + Math.random().toString(36).substring(2, 10);  // Generate a random app name
}



// Function to fetch bot details and env vars from database
async function getBotDetails(botId) {
    try {
        const [botRows] = await pool.query('SELECT * FROM bots WHERE id = ?', [botId]);
        if (botRows.length === 0) {
            throw new Error('Bot not found');
        }

        const [envVars] = await pool.query('SELECT * FROM bot_env_vars WHERE bot_id = ?', [botId]);
        return {
            bot: botRows[0],
            envVars: envVars
        };
    } catch (error) {
        console.error('Error fetching bot details:', error);
        throw error;
    }
}

// Function to save deployment and env vars
async function saveDeployment(userId, botId, appName, envValues) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Insert into deployed_apps
        const [deployResult] = await connection.query(
            'INSERT INTO deployed_apps (user_id, bot_id, app_name, heroku_app_name) VALUES (?, ?, ?, ?)',
            [userId, botId, appName, appName]
        );

        // Only save environment variables if they exist
        if (envValues && typeof envValues === 'object') {
            for (const [key, value] of Object.entries(envValues)) {
                if (key && value !== undefined) {
                    await connection.query(
                        'INSERT INTO deployment_env_vars (deployment_id, var_name, var_value) VALUES (?, ?, ?)',
                        [deployResult.insertId, key, value]
                    );
                }
            }
        }

        await connection.commit();
        return deployResult.insertId;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}


// Modified deploy function to use bot repo from database
async function deployWithMultipleKeys(botId, envValues, userId) {
    const apiKeys = await fetchApiKeys();
    const { bot, envVars } = await getBotDetails(botId);

    if (!bot.repo_url) {
        throw new Error('Bot repository URL not found');
    }

    for (const apiKey of apiKeys) {
        try {
            // Generate unique app name
            const appName = `app-${Math.random().toString(36).substring(2, 10)}`;
            
            // Create Heroku app
            const createAppResponse = await fetch('https://api.heroku.com/apps', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify({ name: appName })
            });

            if (!createAppResponse.ok) continue;

            const appData = await createAppResponse.json();

            // Format config vars properly
            const configVars = {};
            for (const [key, value] of Object.entries(envValues)) {
                if (value && value.trim() !== '') {
                    configVars[key] = value.toString().trim();
                }
            }

            // Set config vars with error handling
            const configResponse = await fetch(`https://api.heroku.com/apps/${appData.name}/config-vars`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify(configVars)
            });

            if (!configResponse.ok) {
                console.error('Failed to set config vars:', await configResponse.text());
                throw new Error('Failed to set environment variables');
            }

            // Verify config vars were set
            const verifyConfigResponse = await fetch(`https://api.heroku.com/apps/${appData.name}/config-vars`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                }
            });

            if (!verifyConfigResponse.ok) {
                throw new Error('Failed to verify environment variables');
            }

            // Link GitHub repo and deploy
            const buildResponse = await fetch(`https://api.heroku.com/apps/${appData.name}/builds`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify({
                    source_blob: {
                        url: `https://github.com/${bot.repo_url}/tarball/main`
                    }
                })
            });

            if (!buildResponse.ok) {
                throw new Error('Failed to initiate build');
            }

            // Save deployment info to database
            const deploymentId = await saveDeployment(userId, botId, appName, configVars);

            return { 
                success: true, 
                appData,
                deploymentId
            };
        } catch (error) {
            console.error(`Error with API key: ${apiKey}`, error.message, error.stack);
            continue;
        }
    }

    throw new Error('Failed to deploy with all available API keys');
}

app.post('/deploy', isLoggedIn, checkUserCoins, async (req, res) => {
    console.log('Request Body:', req.body);
    const { botId, ...envVars } = req.body;
    const envValues = Object.keys(envVars).reduce((acc, key) => {
        const match = key.match(/^envVars\[(.+)\]$/);
        if (match) {
            acc[match[1]] = envVars[key];
        }
        return acc;
    }, {});
    if (!envValues) {
        return res.status(400).json({ error: 'Environment variables are required' });
    }
    console.log('Environment Variables:', envValues);
    
    if (!botId) {
        return res.status(400).json({ error: 'Bot ID is required' });
    }

    try {
        // Verify user has enough coins
        const [userRows] = await pool.query(
            'SELECT id, coins FROM users WHERE phone_number = ?', 
            [req.session.user.phoneNumber]
        );

        if (!userRows.length) {
            return res.status(400).json({ error: 'User not found' });
        }

        if (userRows[0].coins < 10) {
            return res.status(400).json({ error: 'Insufficient coins (10 coins required)' });
        }

        // Deploy the bot
    // Fetch bot's deployment cost
    const [botRows] = await pool.query('SELECT deployment_cost FROM bots WHERE id = ?', [botId]);
    if (!botRows.length) {
        return res.status(400).json({ error: 'Bot not found' });
    }
    const deploymentCost = botRows[0].deployment_cost;

    const result = await deployWithMultipleKeys(botId, envValues, userRows[0].id);

        if (result.success) {
            // Deduct coins after successful deployment
            await pool.query(
                'UPDATE users SET coins = coins - ? WHERE id = ?',
                [deploymentCost, userRows[0].id]
            );

            // Track deployment cost
            await pool.query(
                'INSERT INTO coin_transactions (sender_phone, amount, transaction_type) VALUES (?, ?, ?)',
                [req.session.user.phoneNumber, 10, 'deployment']
            );

            res.json({
                success: true,
                message: 'Bot deployed successfully',
                appUrl: `https://${result.appData.name}.herokuapp.com`,
                deploymentId: result.deploymentId
            });
        } else {
            res.status(500).json({ error: 'Deployment failed', details: result.message });
        }
    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({ 
            error: 'Deployment failed', 
            message: error.message,
            details: error.stack 
        });
    }
});


// Rest of the codeee

// Generate a unique invite code
function generateInviteCode() {
    return Math.random().toString(36).substring(2, 10);
}
// New route to generate an invite link
app.post('/generate-invite', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const inviteCode = generateInviteCode();
        
        await pool.query('INSERT INTO invites (inviter_id, invite_code) VALUES (?, ?)', [userId, inviteCode]);
        
        const inviteLink = `${req.protocol}://${req.get('host')}/signup?invite=${inviteCode}`;
        res.json({ inviteLink });
    } catch (error) {
        console.error('Error generating invite:', error);
        res.status(500).json({ error: 'An error occurred while generating the invite' });
    }
});

// Modify the existing registration route to handle invites
app.post('/signup', async (req, res) => {
    const { phoneNumber, inviteCode } = req.body;
    
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check if the invite code is valid and unused
        const [invite] = await connection.query('SELECT * FROM invites WHERE invite_code = ? AND used = FALSE', [inviteCode]);
        
        let referrerId = null;
        if (invite.length > 0) {
            referrerId = invite[0].inviter_id;
            await connection.query('UPDATE invites SET used = TRUE WHERE id = ?', [invite[0].id]);
        }

        // Create the new user
        await connection.query('INSERT INTO users (phone_number, referrer_id) VALUES (?, ?)', [phoneNumber, referrerId]);
        
        // If there was a valid referrer, reward them with 100 coins
        if (referrerId) {
            await connection.query('UPDATE users SET coins = coins + 100 WHERE id = ?', [referrerId]);
            await connection.query(`
                INSERT INTO coin_transactions (recipient_phone, amount, transaction_type) 
                SELECT phone_number, 100, 'referral_reward'
                FROM users
                WHERE id = ?
            `, [referrerId]);
        }

        await connection.commit();
        res.json({ message: 'Registration successful' });
    } catch (error) {
        await connection.rollback();
        console.error('Error during registration:', error);
        res.status(500).json({ error: 'An error occurred during registration' });
    } finally {
        connection.release();
    }
});

// New route to get user's invite history
app.get('/invite-history', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [invites] = await pool.query(`
            SELECT i.invite_code, i.used, i.created_at, u.phone_number as invited_user
            FROM invites i
            LEFT JOIN users u ON u.referrer_id = i.inviter_id
            WHERE i.inviter_id = ?
            ORDER BY i.created_at DESC
        `, [userId]);
        
        res.json(invites);
    } catch (error) {
        console.error('Error fetching invite history:', error);
        res.status(500).json({ error: 'An error occurred while fetching invite history' });
    }
});

// New route to get user's apps
app.get('/user-apps', isLoggedIn, async (req, res) => {
    try {
        const phoneNumber = req.session.user.phoneNumber;
        const apps = await getUserApps(phoneNumber);
  
        res.json(apps);
    } catch (error) {
        console.error('Error fetching user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});
app.get('/current-user', (req, res) => {
    if (globalUserPhoneNumber) {
        res.json({ phoneNumber: globalUserPhoneNumber });
    } else {
        res.status(401).json({ error: 'No user logged in' });
    }
});

// New API endpoint for getting all apps
app.get('/all-userapps', async (req, res) => {
    try {
        const [apps] = await pool.query(`
            SELECT users.phone_number, deployed_apps.app_name, deployed_apps.deployed_at 
            FROM deployed_apps 
            JOIN users ON deployed_apps.user_id = users.id
        `);
        res.json(apps);
    } catch (error) {
        console.error('Error fetching all user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});

app.get('/app-details/:appName', isLoggedIn, async (req, res) => {
    try {
        const appName = req.params.appName;
        const [app] = await pool.execute('SELECT * FROM deployed_apps WHERE app_name = ?', [appName]);
        if (app.length === 0) {
            return res.status(404).send('App not found');
        }
        res.render('app-details', { app: app[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});


// Sensitive vars to exclude from response
const SENSITIVE_VARS = ['HEROKU_API_KEY', 'HEROKU_APP_NAME'];
app.get('/api/config-vars/:appName', async (req, res) => {
    const appName = req.params.appName;
    try {
        const apiKeys = await fetchApiKeys();
        let configVars = null;
        let lastError = null;

        for (const apiKey of apiKeys) {
            try {
                const response = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                    },
                });
                configVars = response.data;
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (configVars) {
            // Filter out sensitive variables
            const filteredVars = Object.fromEntries(
                Object.entries(configVars).filter(([key]) => !SENSITIVE_VARS.includes(key))
            );
            res.json(filteredVars);
        } else {
            throw lastError || new Error('Failed to fetch config vars');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Failed to fetch config vars');
    }
});

app.post('/api/config-vars/:appName', async (req, res) => {
    const appName = req.params.appName;
    const updatedVars = req.body;
    try {
        const apiKeys = await fetchApiKeys();
        let updated = false;
        let lastError = null;

        for (const apiKey of apiKeys) {
            try {
                const response = await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, updatedVars, {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                    },
                });
                updated = true;
                res.json(response.data);
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!updated) {
            throw lastError || new Error('Failed to update config vars');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Failed to update config vars');
    }
});





app.get('/wallet', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
});

// New route to get user's wallet information
app.get('/api/wallet', isLoggedIn, async (req, res) => {
    try {
        const phoneNumber = req.session.user.phoneNumber;
        const [user] = await pool.query('SELECT coins FROM users WHERE phone_number = ?', [phoneNumber]);
        const [transactions] = await pool.query(`
            SELECT * FROM coin_transactions 
            WHERE sender_phone = ? OR recipient_phone = ? 
            ORDER BY transaction_date DESC 
            LIMIT 10
        `, [phoneNumber, phoneNumber]);
        
        const [deployments] = await pool.query(`
            SELECT COUNT(*) as count, SUM(cost) as total_cost 
            FROM deployed_apps 
            WHERE user_id = (SELECT id FROM users WHERE phone_number = ?)
        `, [phoneNumber]);

        res.json({
            coins: user[0].coins,
            recentTransactions: transactions,
            deployments: deployments[0]
        });
    } catch (error) {
        console.error('Error fetching wallet info:', error);
        res.status(500).json({ error: 'An error occurred while fetching wallet information' });
    }
});

// New route to send coins
app.post('/api/send-coins', isLoggedIn, async (req, res) => {
    const { recipientPhone, amount } = req.body;
    const senderPhone = req.session.user.phoneNumber;

    if (senderPhone === recipientPhone) {
        return res.status(400).json({ error: 'You cannot send coins to yourself' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check sender's balance
        const [sender] = await connection.query('SELECT coins FROM users WHERE phone_number = ?', [senderPhone]);
        if (sender[0].coins < amount) {
            await connection.rollback();
            return res.status(400).json({ error: 'Insufficient coins' });
        }

        // Check if recipient exists
        const [recipient] = await connection.query('SELECT id FROM users WHERE phone_number = ?', [recipientPhone]);
        if (recipient.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Recipient not found' });
        }

        // Update sender's balance
        await connection.query('UPDATE users SET coins = coins - ? WHERE phone_number = ?', [amount, senderPhone]);

        // Update recipient's balance
        await connection.query('UPDATE users SET coins = coins + ? WHERE phone_number = ?', [amount, recipientPhone]);

        // Record transaction
        await connection.query(`
            INSERT INTO coin_transactions (sender_phone, recipient_phone, amount) 
            VALUES (?, ?, ?)
        `, [senderPhone, recipientPhone, amount]);

        await connection.commit();
        res.json({ message: 'Coins sent successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error sending coins:', error);
        res.status(500).json({ error: 'An error occurred while sending coins' });
    } finally {
        connection.release();
    }
});

// New route to deposit coins (for demonstration purposes)
app.post('/api/deposit-coins', isLoggedIn, async (req, res) => {
    const { amount } = req.body;
    const phoneNumber = req.session.user.phoneNumber;

    try {
        await pool.query('UPDATE users SET coins = coins + ? WHERE phone_number = ?', [amount, phoneNumber]);
        await pool.query(`
            INSERT INTO coin_transactions (recipient_phone, amount, transaction_type) 
            VALUES (?, ?, 'deposit')
        `, [phoneNumber, amount]);

        res.json({ message: 'Coins deposited successfully' });
    } catch (error) {
        console.error('Error depositing coins:', error);
        res.status(500).json({ error: 'An error occurred while depositing coins' });
    }
});




// Start the server
app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`));
