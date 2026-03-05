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

// Database connection
const sql = neon(process.env.DATABASE_URL);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Create tables if they don't exist
async function initializeDatabase() {
    try {
        // Create email_sessions table
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

        // Create email_logs table
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
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

initializeDatabase();

// Email transporter configuration
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Verify email configuration
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email configuration error:', error);
    } else {
        console.log('✅ Email server is ready to send messages');
    }
});

// Load email template
const emailTemplatePath = path.join(__dirname, 'views', 'email-template.html');
let emailTemplate = fs.readFileSync(emailTemplatePath, 'utf8');

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get all email sessions
app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = await sql`
            SELECT * FROM email_sessions 
            ORDER BY created_at DESC 
            LIMIT 50
        `;
        res.json({ success: true, sessions });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
    }
});

// Get single session
app.get('/api/sessions/:sessionId', async (req, res) => {
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
        // Save session to database first
        await sql`
            INSERT INTO email_sessions (session_id, subject, recipient_name, recipient_username, recipient_email, status)
            VALUES (${sessionId}, ${subject}, ${name}, ${username}, ${email}, 'pending')
        `;

        // Prepare email content
        const verificationLink = `${process.env.APP_URL}/verify?user=${username}&session=${sessionId}`;
        const unsubscribeLink = `${process.env.APP_URL}/unsubscribe?email=${email}&session=${sessionId}`;

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
            from: `"Business Verification Team" <${process.env.EMAIL_USER}>`,
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

        // Send email
        const info = await transporter.sendMail(mailOptions);

        // Update session status
        await sql`
            UPDATE email_sessions 
            SET status = 'sent' 
            WHERE session_id = ${sessionId}
        `;

        // Log the email
        await sql`
            INSERT INTO email_logs (session_id, email_content, status)
            VALUES (${sessionId}, ${customizedTemplate}, 'success')
        `;

        console.log(`✅ Email sent successfully to ${email}:`, info.messageId);

        res.json({ 
            success: true, 
            message: 'Email sent successfully!',
            sessionId: sessionId,
            messageId: info.messageId
        });

    } catch (error) {
        console.error('❌ Error sending email:', error);

        // Update session status to failed
        try {
            await sql`
                UPDATE email_sessions 
                SET status = 'failed' 
                WHERE session_id = ${sessionId}
            `;

            await sql`
                INSERT INTO email_logs (session_id, email_content, status, error_message)
                VALUES (${sessionId}, '', 'failed', ${error.message})
            `;
        } catch (dbError) {
            console.error('Error updating failed session:', dbError);
        }

        res.status(500).json({ 
            success: false, 
            error: 'Failed to send email. Please try again.',
            details: error.message 
        });
    }
});

// Resend email
app.post('/api/resend-email/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        // Get original session
        const sessions = await sql`
            SELECT * FROM email_sessions 
            WHERE session_id = ${sessionId}
        `;

        if (sessions.length === 0) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const session = sessions[0];
        
        // Resend email with same data
        const newSessionId = uuidv4();
        const verificationLink = `${process.env.APP_URL}/verify?user=${session.recipient_username}&session=${newSessionId}`;
        const unsubscribeLink = `${process.env.APP_URL}/unsubscribe?email=${session.recipient_email}&session=${newSessionId}`;

        let customizedTemplate = emailTemplate
            .replace(/{{name}}/g, session.recipient_name)
            .replace(/{{username}}/g, session.recipient_username)
            .replace(/{{subject}}/g, session.subject)
            .replace(/{{verificationLink}}/g, verificationLink)
            .replace(/{{unsubscribeLink}}/g, unsubscribeLink)
            .replace(/{{year}}/g, new Date().getFullYear());

        const mailOptions = {
            from: `"Business Verification Team" <${process.env.EMAIL_USER}>`,
            to: session.recipient_email,
            subject: session.subject,
            html: customizedTemplate,
            headers: {
                'List-Unsubscribe': `<${unsubscribeLink}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        };

        const info = await transporter.sendMail(mailOptions);

        // Create new session for resend
        await sql`
            INSERT INTO email_sessions (session_id, subject, recipient_name, recipient_username, recipient_email, status)
            VALUES (${newSessionId}, ${session.subject}, ${session.recipient_name}, ${session.recipient_username}, ${session.recipient_email}, 'resent')
        `;

        await sql`
            INSERT INTO email_logs (session_id, email_content, status)
            VALUES (${newSessionId}, ${customizedTemplate}, 'resent')
        `;

        res.json({ 
            success: true, 
            message: 'Email resent successfully!',
            newSessionId: newSessionId
        });

    } catch (error) {
        console.error('Error resending email:', error);
        res.status(500).json({ success: false, error: 'Failed to resend email' });
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

// Verification endpoint (for the button in email)
app.get('/verify', (req, res) => {
    const { user, session } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Verification Successful</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #28a745; }
                p { color: #666; line-height: 1.6; }
                .badge { background: #28a745; color: white; padding: 10px 20px; border-radius: 50px; display: inline-block; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>✓ Verification Successful!</h1>
                <div class="badge">VERIFIED BUSINESS</div>
                <p>Hello <strong>${user}</strong>,</p>
                <p>Your business account has been successfully verified!<br>
                You can now access all verified business features.</p>
                <p><small>Session ID: ${session}</small></p>
            </div>
        </body>
        </html>
    `);
});

// Unsubscribe endpoint
app.get('/unsubscribe', async (req, res) => {
    const { email, session } = req.query;
    
    // Here you would add logic to unsubscribe the user
    // For now, just show confirmation
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Unsubscribed</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #dc3545; }
                p { color: #666; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Unsubscribed</h1>
                <p>You have been successfully unsubscribed from business verification emails.</p>
                <p>Email: <strong>${email}</strong></p>
                <p>You won't receive any further notifications from this service.</p>
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