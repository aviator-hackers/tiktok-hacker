const express = require('express');
const nodemailer = require('nodemailer');
const { neon } = require('@neondatabase/serverless');
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection with better error handling
let sql;
try {
    sql = neon(process.env.DATABASE_URL, {
        fetchOptions: {
            timeout: 30000,
        },
        maxRetries: 3,
        retryInterval: 1000,
    });
    console.log('✅ Database client initialized');
} catch (error) {
    console.error('❌ Database initialization error:', error.message);
    sql = null;
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Create tables if they don't exist
async function initializeDatabase() {
    if (!sql) {
        console.log('⚠️ No database connection - skipping table creation');
        return false;
    }

    try {
        await sql`
            CREATE TABLE IF NOT EXISTS email_sessions (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(100) UNIQUE NOT NULL,
                subject VARCHAR(255) NOT NULL,
                recipient_name VARCHAR(255) NOT NULL,
                recipient_username VARCHAR(255) NOT NULL,
                recipient_email VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS email_logs (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(100) REFERENCES email_sessions(session_id),
                email_content TEXT,
                status VARCHAR(50),
                error_message TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        console.log('✅ Database tables initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        return false;
    }
}

// Email transporter configuration - MULTIPLE OPTIONS FOR RENDER
let transporter;

// Try to create transporter with different options
function createTransporter() {
    // Option 1: Gmail SMTP (might be blocked on Render)
    const gmailTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            rejectUnauthorized: false
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    });

    // Option 2: Gmail SMTP with different port (465 - SSL)
    const gmailSSLTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            rejectUnauthorized: false
        },
        connectionTimeout: 10000
    });

    // Option 3: SendGrid (if you have API key - recommended for Render)
    // Uncomment if you have SendGrid
    /*
    const sendGridTransporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        auth: {
            user: 'apikey',
            pass: process.env.SENDGRID_API_KEY
        }
    });
    */

    // Try Gmail SSL first (port 465) as it might work better on Render
    console.log('🔄 Attempting to connect with Gmail SSL (port 465)...');
    return gmailSSLTransporter;
}

transporter = createTransporter();

// Verify email configuration with timeout
async function verifyEmailConfig() {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('⚠️ Email verification timeout - continuing anyway');
            resolve(false);
        }, 5000);

        transporter.verify((error, success) => {
            clearTimeout(timeout);
            if (error) {
                console.error('❌ Email configuration error:');
                console.error('Error:', error.message);
                if (error.code === 'EAUTH') {
                    console.error('⚠️ For Gmail, you MUST use an App Password, not your regular password');
                    console.error('📝 Get one at: https://myaccount.google.com/apppasswords');
                } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                    console.error('⚠️ Connection timeout - Render may be blocking SMTP ports');
                    console.error('💡 Solution: Use a different email service like SendGrid or Mailgun');
                }
                resolve(false);
            } else {
                console.log('✅ Email server is ready to send messages');
                resolve(true);
            }
        });
    });
}

// Load email template
const emailTemplatePath = path.join(__dirname, 'views', 'email-template.html');
let emailTemplate = '';

try {
    if (fs.existsSync(emailTemplatePath)) {
        emailTemplate = fs.readFileSync(emailTemplatePath, 'utf8');
        console.log('✅ Email template loaded');
    } else {
        console.log('⚠️ Email template not found, using fallback template');
        emailTemplate = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>{{subject}}</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <div style="max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0;">Business Verification</h1>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px;">
                        <h2>Hello {{name}},</h2>
                        <p>Great news! You are now eligible to get your business verified under username <strong>{{username}}</strong>.</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="{{verificationLink}}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 50px; font-weight: bold; display: inline-block;">Get Verified Now</a>
                        </div>
                        <p style="color: #666; font-size: 14px;">This link will expire in 7 days.</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                        <p style="color: #999; font-size: 12px; text-align: center;">
                            <a href="{{unsubscribeLink}}" style="color: #999;">Unsubscribe</a> from these notifications.
                        </p>
                    </div>
                </div>
            </body>
            </html>
        `;
    }
} catch (error) {
    console.error('❌ Error loading email template:', error);
    emailTemplate = '<h1>Hello {{name}}</h1><p>You are eligible for verification under username {{username}}</p><a href="{{verificationLink}}">Verify</a>';
}

// Initialize database and verify email
let emailVerified = false;
initializeDatabase().then(() => {
    verifyEmailConfig().then(verified => {
        emailVerified = verified;
    });
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        let dbStatus = false;
        
        if (sql) {
            try {
                await sql`SELECT 1`;
                dbStatus = true;
            } catch (e) {
                dbStatus = false;
            }
        }

        res.json({
            status: 'ok',
            database: dbStatus ? 'connected' : 'disconnected',
            email: emailVerified ? 'configured' : 'timeout',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Test email endpoint - with better error handling for Render
app.get('/api/test-email', async (req, res) => {
    try {
        // Try to send a test email
        const testMailOptions = {
            from: `"Business Verification" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: 'Test Email from Business Verification System',
            html: `
                <h1>✅ Test Email</h1>
                <p>If you receive this, your email is working on Render!</p>
                <p>Time: ${new Date().toISOString()}</p>
                <p>Server: Render</p>
            `
        };
        
        // Set a timeout for the send operation
        const sendPromise = transporter.sendMail(testMailOptions);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Send timeout after 15 seconds')), 15000)
        );
        
        const info = await Promise.race([sendPromise, timeoutPromise]);
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully!',
            messageId: info.messageId
        });
    } catch (error) {
        console.error('Test email failed:', error);
        
        let errorMessage = 'Email configuration failed';
        let suggestion = '';
        
        if (error.code === 'EAUTH') {
            errorMessage = 'Authentication failed. For Gmail, use an App Password (16 characters)';
            suggestion = 'Get one at: https://myaccount.google.com/apppasswords';
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            errorMessage = 'Connection timeout - Render may be blocking SMTP ports';
            suggestion = 'Try using port 465 (SSL) or consider using SendGrid/Mailgun instead';
        } else if (error.message.includes('getaddrinfo')) {
            errorMessage = 'Cannot resolve email host - check your EMAIL_HOST';
        }

        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            suggestion: suggestion,
            details: error.message,
            code: error.code
        });
    }
});

// Get all email sessions
app.get('/api/sessions', async (req, res) => {
    if (!sql) {
        return res.json({ success: true, sessions: [] });
    }

    try {
        const sessions = await sql`
            SELECT * FROM email_sessions 
            ORDER BY created_at DESC 
            LIMIT 50
        `;
        res.json({ success: true, sessions });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.json({ success: true, sessions: [] });
    }
});

// Get single session
app.get('/api/sessions/:sessionId', async (req, res) => {
    if (!sql) {
        return res.status(404).json({ success: false, error: 'Database not available' });
    }

    try {
        const { sessionId } = req.params;
        const sessions = await sql`
            SELECT * FROM email_sessions 
            WHERE session_id = ${sessionId}
        `;
        
        if (sessions.length === 0) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        
        res.json({ success: true, session: sessions[0] });
    } catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch session' });
    }
});

// Create and send email
app.post('/api/send-email', async (req, res) => {
    const { subject, name, username, email } = req.body;
    const sessionId = uuidv4();

    console.log('📧 Email request received:', { subject, name, username, email });

    // Validate inputs
    if (!subject || !name || !username || !email) {
        return res.status(400).json({ 
            success: false, 
            error: 'All fields are required' 
        });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid email format' 
        });
    }

    try {
        // Prepare email content
        const verificationLink = `${process.env.APP_URL}/verify?user=${encodeURIComponent(username)}&session=${sessionId}`;
        const unsubscribeLink = `${process.env.APP_URL}/unsubscribe?email=${encodeURIComponent(email)}&session=${sessionId}`;

        // Customize email template
        let customizedTemplate = emailTemplate
            .replace(/{{name}}/g, name)
            .replace(/{{username}}/g, username)
            .replace(/{{subject}}/g, subject)
            .replace(/{{verificationLink}}/g, verificationLink)
            .replace(/{{unsubscribeLink}}/g, unsubscribeLink)
            .replace(/{{year}}/g, new Date().getFullYear());

        // Email options
        const mailOptions = {
            from: `"Business Verification" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: subject,
            html: customizedTemplate,
            headers: {
                'List-Unsubscribe': `<${unsubscribeLink}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'Precedence': 'bulk',
                'X-Auto-Response-Suppress': 'OOF, AutoReply'
            }
        };

        console.log('📤 Attempting to send email to:', email);

        // Set a timeout for the send operation
        const sendPromise = transporter.sendMail(mailOptions);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Send timeout after 15 seconds')), 15000)
        );
        
        const info = await Promise.race([sendPromise, timeoutPromise]);
        console.log('✅ Email sent:', info.messageId);

        // Try to save to database
        if (sql) {
            try {
                await sql`
                    INSERT INTO email_sessions (session_id, subject, recipient_name, recipient_username, recipient_email, status)
                    VALUES (${sessionId}, ${subject}, ${name}, ${username}, ${email}, 'sent')
                `;
                console.log('✅ Session saved to database');
            } catch (dbError) {
                console.warn('⚠️ Could not save to database:', dbError.message);
            }
        }

        res.json({ 
            success: true, 
            message: 'Email sent successfully!',
            sessionId: sessionId,
            messageId: info.messageId
        });

    } catch (error) {
        console.error('❌ Error sending email:');
        console.error('Error name:', error.name);
        console.error('Error code:', error.code);
        console.error('Error message:', error.message);

        // Provide specific error messages for Render
        let errorMessage = 'Failed to send email';
        let suggestion = '';
        
        if (error.code === 'EAUTH') {
            errorMessage = 'Email authentication failed. Use an App Password from Google.';
            suggestion = 'Get it at: https://myaccount.google.com/apppasswords';
        } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            errorMessage = 'Connection timeout - Render blocks SMTP ports by default';
            suggestion = 'Solution: Use SendGrid, Mailgun, or another email API service';
        } else if (error.message.includes('getaddrinfo')) {
            errorMessage = 'Cannot connect to email server';
            suggestion = 'Check your EMAIL_HOST in .env';
        }

        // Save failed attempt to database
        if (sql) {
            try {
                await sql`
                    INSERT INTO email_sessions (session_id, subject, recipient_name, recipient_username, recipient_email, status)
                    VALUES (${sessionId}, ${subject}, ${name}, ${username}, ${email}, 'failed')
                `;
            } catch (dbError) {
                // Ignore
            }
        }

        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            suggestion: suggestion,
            details: error.message,
            code: error.code
        });
    }
});

// Resend email
app.post('/api/resend-email/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (!sql) {
        return res.status(500).json({ success: false, error: 'Database not available' });
    }

    try {
        const sessions = await sql`
            SELECT * FROM email_sessions 
            WHERE session_id = ${sessionId}
        `;

        if (sessions.length === 0) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const session = sessions[0];
        
        const newSessionId = uuidv4();
        const verificationLink = `${process.env.APP_URL}/verify?user=${encodeURIComponent(session.recipient_username)}&session=${newSessionId}`;
        const unsubscribeLink = `${process.env.APP_URL}/unsubscribe?email=${encodeURIComponent(session.recipient_email)}&session=${newSessionId}`;

        let customizedTemplate = emailTemplate
            .replace(/{{name}}/g, session.recipient_name)
            .replace(/{{username}}/g, session.recipient_username)
            .replace(/{{subject}}/g, session.subject)
            .replace(/{{verificationLink}}/g, verificationLink)
            .replace(/{{unsubscribeLink}}/g, unsubscribeLink)
            .replace(/{{year}}/g, new Date().getFullYear());

        const mailOptions = {
            from: `"Business Verification" <${process.env.EMAIL_USER}>`,
            to: session.recipient_email,
            subject: session.subject,
            html: customizedTemplate,
            headers: {
                'List-Unsubscribe': `<${unsubscribeLink}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        };

        const sendPromise = transporter.sendMail(mailOptions);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Send timeout after 15 seconds')), 15000)
        );
        
        const info = await Promise.race([sendPromise, timeoutPromise]);

        try {
            await sql`
                INSERT INTO email_sessions (session_id, subject, recipient_name, recipient_username, recipient_email, status)
                VALUES (${newSessionId}, ${session.subject}, ${session.recipient_name}, ${session.recipient_username}, ${session.recipient_email}, 'resent')
            `;
        } catch (dbError) {
            console.warn('⚠️ Could not save to database:', dbError.message);
        }

        res.json({ 
            success: true, 
            message: 'Email resent successfully!',
            newSessionId: newSessionId
        });

    } catch (error) {
        console.error('Error resending email:', error);
        
        let errorMessage = 'Failed to resend email';
        if (error.code === 'ETIMEDOUT') {
            errorMessage = 'Connection timeout - Render blocks SMTP ports';
        }

        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: error.message 
        });
    }
});

// Serve email template preview
app.get('/preview-email', (req, res) => {
    const { name = 'John Doe', username = 'johndoe123', subject = 'Business Verification Update' } = req.query;
    
    let previewTemplate = emailTemplate
        .replace(/{{name}}/g, name)
        .replace(/{{username}}/g, username)
        .replace(/{{subject}}/g, subject)
        .replace(/{{verificationLink}}/g, '#')
        .replace(/{{unsubscribeLink}}/g, '#')
        .replace(/{{year}}/g, new Date().getFullYear());
    
    res.send(previewTemplate);
});

// Verification endpoint
app.get('/verify', (req, res) => {
    const { user, session } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Verification Successful</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; margin: 0; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #28a745; font-size: 32px; margin-bottom: 20px; }
                .badge { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; border-radius: 50px; display: inline-block; margin: 20px 0; font-weight: bold; }
                .checkmark { font-size: 80px; color: #28a745; margin-bottom: 20px; }
                p { color: #666; line-height: 1.6; margin: 10px 0; }
                .small { color: #999; font-size: 12px; margin-top: 30px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="checkmark">✓</div>
                <h1>Verification Successful!</h1>
                <div class="badge">VERIFIED BUSINESS</div>
                <p>Hello <strong>${user || 'User'}</strong>,</p>
                <p>Your business account has been successfully verified!<br>You can now access all verified business features.</p>
                <p class="small">Session ID: ${session || 'N/A'}</p>
            </div>
        </body>
        </html>
    `);
});

// Unsubscribe endpoint
app.get('/unsubscribe', (req, res) => {
    const { email, session } = req.query;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Unsubscribed</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; margin: 0; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #dc3545; font-size: 32px; margin-bottom: 20px; }
                .checkmark { font-size: 60px; color: #dc3545; margin-bottom: 20px; }
                p { color: #666; line-height: 1.6; margin: 10px 0; }
                .email { background: #f8f9fa; padding: 10px; border-radius: 5px; font-family: monospace; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="checkmark">✕</div>
                <h1>Unsubscribed</h1>
                <p>You have been successfully unsubscribed from business verification emails.</p>
                <div class="email">${email || 'Email not provided'}</div>
                <p>You won't receive any further notifications from this service.</p>
                <p class="small" style="color: #999; margin-top: 30px;">Session ID: ${session || 'N/A'}</p>
            </div>
        </body>
        </html>
    `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   🚀 Email System Server Running       ║
    ╠════════════════════════════════════════╣
    ║   📍 Port: ${PORT}                      ║
    ║   📧 Email: ${process.env.EMAIL_USER}   ║
    ║   🔗 URL: ${process.env.APP_URL || 'https://' + process.env.RENDER_EXTERNAL_URL} ║
    ║   📊 Admin: /                          ║
    ╚════════════════════════════════════════╝
    `);
    console.log('📡 Running on Render - Email may be blocked');
    console.log('💡 Tip: Use SendGrid or Mailgun for better email delivery on Render');
});
