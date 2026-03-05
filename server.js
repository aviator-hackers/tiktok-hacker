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

// Email transporter configuration
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT),
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

// Verify email configuration
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email configuration error:');
        console.error('Error:', error.message);
        if (error.code === 'EAUTH') {
            console.error('⚠️ For Gmail, you MUST use an App Password, not your regular password');
            console.error('📝 Get one at: https://myaccount.google.com/apppasswords');
        }
    } else {
        console.log('✅ Email server is ready to send messages');
    }
});

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

// Initialize database
initializeDatabase();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const emailStatus = await transporter.verify().then(() => true).catch(() => false);
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
            email: emailStatus ? 'configured' : 'error',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Test email endpoint
app.get('/api/test-email', async (req, res) => {
    try {
        await transporter.verify();
        
        const testMailOptions = {
            from: `"Test" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: 'Test Email from Business Verification System',
            html: `
                <h1>✅ Test Email Successful!</h1>
                <p>Your email configuration is working properly.</p>
                <p>Time: ${new Date().toISOString()}</p>
            `
        };
        
        const info = await transporter.sendMail(testMailOptions);
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully!',
            messageId: info.messageId
        });
    } catch (error) {
        console.error('Test email failed:', error);
        
        let errorMessage = 'Email configuration failed';
        if (error.code === 'EAUTH') {
            errorMessage = 'Authentication failed. For Gmail, use an App Password (16 characters)';
        } else if (error.code === 'ESOCKET') {
            errorMessage = 'Connection failed. Check host and port settings.';
        } else if (error.message.includes('Invalid login')) {
            errorMessage = 'Invalid email or password.';
        }

        res.status(500).json({ 
            success: false, 
            error: errorMessage,
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
        // First, verify email transporter
        await transporter.verify();
        console.log('✅ Transporter verified');

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

        console.log('📤 Sending email to:', email);

        // Send email
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent:', info.messageId);

        // Try to save to database (don't fail if DB is down)
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
        
        if (error.response) {
            console.error('SMTP Response:', error.response);
        }

        // Provide specific error messages
        let errorMessage = 'Failed to send email';
        let errorDetails = error.message;
        
        if (error.code === 'EAUTH') {
            errorMessage = 'Email authentication failed. For Gmail, you must use an App Password (16 characters) from https://myaccount.google.com/apppasswords';
            errorDetails = 'Invalid login credentials - use App Password not regular password';
        } else if (error.code === 'ESOCKET') {
            errorMessage = 'Cannot connect to email server. Check your network and email settings.';
        } else if (error.code === 'EENVELOPE') {
            errorMessage = 'Invalid recipient email address.';
        } else if (error.message.includes('Invalid login')) {
            errorMessage = 'Invalid email login. Please check your email and password.';
            errorDetails = 'Use App Password for Gmail accounts with 2FA enabled';
        } else if (error.message.includes('getaddrinfo')) {
            errorMessage = 'Cannot resolve email host. Check EMAIL_HOST in .env';
        }

        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: errorDetails,
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

        const info = await transporter.sendMail(mailOptions);

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
        res.status(500).json({ 
            success: false, 
            error: 'Failed to resend email',
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
app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   🚀 Email System Server Running       ║
    ╠════════════════════════════════════════╣
    ║   📍 Port: ${PORT}                      ║
    ║   📧 Email: ${process.env.EMAIL_USER}   ║
    ║   🔗 URL: ${process.env.APP_URL}        ║
    ║   📊 Admin: ${process.env.APP_URL}      ║
    ╚════════════════════════════════════════╝
    `);
});
