// plain Node + pg. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { Pool } = require('pg');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_ATTEMPTS = 10;
let currentPort = DEFAULT_PORT;
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || 'admin';
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || 'admin123';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS teachers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS students (
            enrollment TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            section TEXT NOT NULL,
            dob DATE,
            name_change_otp TEXT,
            name_change_otp_expires TIMESTAMPTZ
        );
        ALTER TABLE students ADD COLUMN IF NOT EXISTS dob DATE;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS name_change_otp TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS name_change_otp_expires TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,
            teacher_id TEXT NOT NULL,
            teacher_name TEXT NOT NULL,
            subject TEXT,
            qr_token TEXT,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS attendance (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES sessions(id),
            enrollment TEXT NOT NULL,
            name TEXT NOT NULL,
            section TEXT NOT NULL,
            time TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(session_id, enrollment)
        );
    `);
}

// --- SSE clients (in-memory, per-process — fine for a single Render instance) ---
let clients = [];
function broadcastTo(teacherId, data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clients.filter(c => c.teacherId === teacherId).forEach(c => c.res.write(msg));
}
function broadcastAll(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(c => c.res.write(msg));
}

function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) { reject(e); }
        });
    });
}

function csvEscape(v) {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(subject, rows) {
    const header = 'Name,Enrollment,Section,Subject,Time\n';
    return header + rows.map(r =>
        [r.name, r.enrollment, r.section, subject || '', r.time.toISOString()].map(csvEscape).join(',')
    ).join('\n');
}

function safeFilename(teacherName, subject, sessionId) {
    const base = `${teacherName}-${subject || 'no-subject'}-session-${sessionId}`;
    return base.replace(/[^a-zA-Z0-9 \-_.]/g, '').trim().replace(/\s+/g, '-') + '.csv';
}

// --- DB helpers ---
async function getTeacherById(id) {
    if (!id) return null;
    const r = await pool.query('SELECT * FROM teachers WHERE id = $1', [id]);
    return r.rows[0] || null;
}
async function getActiveSession(teacherId) {
    const r = await pool.query('SELECT * FROM sessions WHERE teacher_id = $1 AND active = true ORDER BY id DESC LIMIT 1', [teacherId]);
    return r.rows[0] || null;
}
async function getPresentMap(sessionId) {
    const r = await pool.query('SELECT enrollment, name, section, time FROM attendance WHERE session_id = $1 ORDER BY time', [sessionId]);
    const present = {};
    for (const row of r.rows) {
        present[row.enrollment] = { name: row.name, enrollment: row.enrollment, section: row.section, time: row.time.toISOString() };
    }
    return present;
}
async function sessionToJson(session) {
    if (!session) return null;
    const present = await getPresentMap(session.id);
    return {
        id: session.id,
        teacherId: session.teacher_id,
        teacherName: session.teacher_name,
        subject: session.subject,
        qrToken: session.qr_token,
        present,
        createdAt: session.created_at.toISOString(),
        active: session.active
    };
}

const server = http.createServer(async (req, res) => {
    try {
        const host = (req.headers && req.headers.host) ? req.headers.host : `localhost:${currentPort}`;
        const { pathname, searchParams } = new URL(req.url ?? '/', `http://${host}`);

        // --- static pages ---
        if (req.method === 'GET' && ['/', '/student.html', '/admin.html', '/superadmin.html'].includes(pathname)) {
            const file = pathname === '/' ? 'student.html' : pathname.slice(1);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
        }

        // --- student registration ---
        if (req.method === 'POST' && pathname === '/api/register') {
            const { name, enrollment, section, dob } = await readBody(req);

            const normalizedName = (name || '').trim();
            const normalizedEnrollment = (enrollment || '').trim().toUpperCase();
            const normalizedSection = (section || '').trim().toUpperCase();
            const normalizedDob = (dob || '').trim();

            if (!normalizedName) return send(res, 400, { error: 'Name is required' });
            if (!normalizedEnrollment) return send(res, 400, { error: 'Enrollment ID is required' });
            if (!normalizedDob) return send(res, 400, { error: 'Date of birth is required' });
            if (!normalizedSection) return send(res, 400, { error: 'Section is required' });

            const nameRegex = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
            if (normalizedName.length > 100) return send(res, 400, { error: 'Name must not exceed 100 characters' });
            if (!nameRegex.test(normalizedName)) return send(res, 400, { error: 'Name must contain letters and spaces only' });

            const enrollmentRegex = /^ADTU\/\d+\/\d{4}-\d{2,4}\/[A-Z0-9]+\/\d+$/;
            if (!enrollmentRegex.test(normalizedEnrollment))
                return send(res, 400, { error: 'Invalid enrollment ID format. Expected format: ADTU/1/2023-26/BCAO/012' });

            const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
            const dobDate = dobRegex.test(normalizedDob) ? new Date(normalizedDob + 'T00:00:00Z') : null;
            if (!dobDate || isNaN(dobDate.getTime()) || dobDate.getTime() > Date.now())
                return send(res, 400, { error: 'Enter a valid date of birth' });

            const sectionRegex = /^[A-Z]$/;
            if (!sectionRegex.test(normalizedSection)) return send(res, 400, { error: 'Section must be a single letter (e.g. A, B, C)' });

            const existing = await pool.query('SELECT 1 FROM students WHERE enrollment = $1', [normalizedEnrollment]);
            if (existing.rows.length) return send(res, 409, { error: 'Student with this enrollment ID is already registered' });

            await pool.query('INSERT INTO students (enrollment, name, section, dob) VALUES ($1, $2, $3, $4)', [normalizedEnrollment, normalizedName, normalizedSection, normalizedDob]);
            return send(res, 200, { ok: true });
        }

        // --- student login (enrollment + date of birth) ---
        if (req.method === 'POST' && pathname === '/api/student-login') {
            const { enrollment, dob } = await readBody(req);
            const normalizedEnrollment = (enrollment || '').trim().toUpperCase();
            const normalizedDob = (dob || '').trim();

            if (!normalizedEnrollment || !normalizedDob) return send(res, 400, { error: 'Enrollment ID and date of birth are required' });

            const dobRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dobRegex.test(normalizedDob)) return send(res, 400, { error: 'Enter a valid date of birth' });

            const r = await pool.query('SELECT * FROM students WHERE enrollment = $1', [normalizedEnrollment]);
            const student = r.rows[0];
            if (!student) return send(res, 404, { error: 'No profile found for this enrollment ID. Please register first.' });

            if (!student.dob) {
                // Profile predates date-of-birth login — claim this DOB now so future logins can verify against it.
                await pool.query('UPDATE students SET dob = $1 WHERE enrollment = $2', [normalizedDob, normalizedEnrollment]);
            } else {
                const storedDob = student.dob.toISOString().slice(0, 10);
                if (storedDob !== normalizedDob) return send(res, 401, { error: 'Enrollment ID or date of birth is incorrect' });
            }

            return send(res, 200, { ok: true, profile: { name: student.name, enrollment: student.enrollment, section: student.section } });
        }

        // --- a student's total attendance, overall and by subject ---
        if (req.method === 'GET' && pathname === '/api/my-attendance') {
            const enrollment = (searchParams.get('enrollment') || '').trim().toUpperCase();
            if (!enrollment) return send(res, 400, { error: 'enrollment is required' });

            const studentR = await pool.query('SELECT 1 FROM students WHERE enrollment = $1', [enrollment]);
            if (!studentR.rows.length) return send(res, 404, { error: 'No profile found for this enrollment ID' });

            const sessionsR = await pool.query(`
                SELECT a.time, s.id AS session_id, s.subject, s.teacher_name
                FROM attendance a
                JOIN sessions s ON s.id = a.session_id
                WHERE a.enrollment = $1
                ORDER BY a.time DESC
            `, [enrollment]);

            const bySubjectR = await pool.query(`
                SELECT s.teacher_id, s.teacher_name, COALESCE(s.subject, 'No subject') AS subject,
                       COUNT(DISTINCT s.id) AS total_sessions,
                       COUNT(DISTINCT CASE WHEN a.enrollment = $1 THEN a.session_id END) AS present_sessions
                FROM sessions s
                LEFT JOIN attendance a ON a.session_id = s.id
                GROUP BY s.teacher_id, s.teacher_name, s.subject
                HAVING COUNT(DISTINCT CASE WHEN a.enrollment = $1 THEN a.session_id END) > 0
                ORDER BY subject
            `, [enrollment]);

            return send(res, 200, {
                totalPresent: sessionsR.rows.length,
                sessions: sessionsR.rows.map(r => ({
                    time: r.time.toISOString(), subject: r.subject, teacherName: r.teacher_name, sessionId: r.session_id
                })),
                bySubject: bySubjectR.rows.map(r => ({
                    subject: r.subject, teacherName: r.teacher_name,
                    totalSessions: Number(r.total_sessions), presentSessions: Number(r.present_sessions)
                }))
            });
        }

        // --- teacher generates a one-time code so a student can correct their own name ---
        if (req.method === 'POST' && pathname === '/api/teacher/generate-name-otp') {
            const { teacherId, enrollment } = await readBody(req);
            const teacher = await getTeacherById(teacherId);
            if (!teacher) return send(res, 401, { error: 'not logged in' });

            const normalizedEnrollment = (enrollment || '').trim().toUpperCase();
            if (!normalizedEnrollment) return send(res, 400, { error: 'Enter a student enrolment ID' });

            const studentR = await pool.query('SELECT * FROM students WHERE enrollment = $1', [normalizedEnrollment]);
            const student = studentR.rows[0];
            if (!student) return send(res, 404, { error: 'No student found with that enrolment ID' });

            const otp = String(nodeCrypto.randomInt(100000, 1000000));
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
            await pool.query('UPDATE students SET name_change_otp = $1, name_change_otp_expires = $2 WHERE enrollment = $3', [otp, expiresAt, normalizedEnrollment]);

            return send(res, 200, { ok: true, otp, expiresAt: expiresAt.toISOString(), studentName: student.name, enrollment: normalizedEnrollment });
        }

        // --- student redeems the code to correct their own name ---
        if (req.method === 'POST' && pathname === '/api/change-name') {
            const { enrollment, newName, otp } = await readBody(req);
            const normalizedEnrollment = (enrollment || '').trim().toUpperCase();
            const normalizedName = (newName || '').trim();
            const normalizedOtp = String(otp || '').trim();

            const nameRegex = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
            if (!normalizedName || normalizedName.length > 100 || !nameRegex.test(normalizedName))
                return send(res, 400, { error: 'Enter a valid name (letters and spaces only)' });
            if (!normalizedOtp) return send(res, 400, { error: 'Enter the one-time code your teacher gave you' });

            const studentR = await pool.query('SELECT * FROM students WHERE enrollment = $1', [normalizedEnrollment]);
            const student = studentR.rows[0];
            if (!student) return send(res, 404, { error: 'register first' });

            if (!student.name_change_otp || !student.name_change_otp_expires)
                return send(res, 400, { error: 'No pending name-change code. Ask your teacher to generate one.' });
            if (new Date(student.name_change_otp_expires).getTime() < Date.now())
                return send(res, 410, { error: 'This code has expired. Ask your teacher for a new one.' });
            if (normalizedOtp !== student.name_change_otp)
                return send(res, 401, { error: 'Incorrect code.' });

            await pool.query(
                'UPDATE students SET name = $1, name_change_otp = NULL, name_change_otp_expires = NULL WHERE enrollment = $2',
                [normalizedName, normalizedEnrollment]
            );
            // Keep past attendance records (and any teacher's live view) in sync with the corrected name.
            await pool.query('UPDATE attendance SET name = $1 WHERE enrollment = $2', [normalizedName, normalizedEnrollment]);
            broadcastAll({ type: 'name-changed', enrollment: normalizedEnrollment, name: normalizedName });
            return send(res, 200, { ok: true, name: normalizedName });
        }

        // --- mark attendance ---
        if (req.method === 'POST' && pathname === '/api/mark') {
            const { enrollment, token } = await readBody(req);
            const studentR = await pool.query('SELECT * FROM students WHERE enrollment = $1', [enrollment]);
            const student = studentR.rows[0];
            if (!student) return send(res, 404, { error: 'register first' });
            if (!token) return send(res, 400, { error: 'missing QR token — scan the code again' });

            const sessionR = await pool.query('SELECT * FROM sessions WHERE active = true AND qr_token = $1', [token]);
            const session = sessionR.rows[0];
            if (!session) return send(res, 401, { error: 'QR code is invalid or expired' });

            const dupe = await pool.query('SELECT 1 FROM attendance WHERE session_id = $1 AND enrollment = $2', [session.id, enrollment]);
            if (dupe.rows.length) return send(res, 200, { ok: true, already: true });

            const time = new Date();
            await pool.query(
                'INSERT INTO attendance (session_id, enrollment, name, section, time) VALUES ($1, $2, $3, $4, $5)',
                [session.id, student.enrollment, student.name, student.section, time]
            );
            broadcastTo(session.teacher_id, {
                type: 'mark',
                student: { name: student.name, enrollment: student.enrollment, section: student.section, time: time.toISOString() }
            });
            return send(res, 200, { ok: true });
        }

        // --- teacher auth ---
        if (req.method === 'POST' && pathname === '/api/login') {
            const { username, password } = await readBody(req);
            const r = await pool.query('SELECT * FROM teachers WHERE username = $1 AND password = $2', [username, password]);
            const teacher = r.rows[0];
            if (!teacher) return send(res, 401, { error: 'invalid credentials' });
            return send(res, 200, { ok: true, teacherId: teacher.id, teacherName: teacher.name });
        }

        // --- start session ---
        if (req.method === 'POST' && pathname === '/api/start-session') {
            const { teacherId, subject } = await readBody(req);
            const teacher = await getTeacherById(teacherId);
            if (!teacher) return send(res, 401, { error: 'not logged in' });

            await pool.query('UPDATE sessions SET active = false, qr_token = NULL WHERE teacher_id = $1 AND active = true', [teacher.id]);

            const qrToken = nodeCrypto.randomBytes(32).toString('hex');
            const subjectVal = subject && subject.trim() ? subject.trim() : null;
            const insert = await pool.query(
                'INSERT INTO sessions (teacher_id, teacher_name, subject, qr_token, active) VALUES ($1, $2, $3, $4, true) RETURNING *',
                [teacher.id, teacher.name, subjectVal, qrToken]
            );
            const session = await sessionToJson(insert.rows[0]);
            broadcastTo(teacher.id, { type: 'new-session', session });
            return send(res, 200, { qrToken: session.qrToken, sessionId: session.id });
        }

        // --- close session ---
        if (req.method === 'POST' && pathname === '/api/close-session') {
            const { teacherId } = await readBody(req);
            const r = await pool.query('UPDATE sessions SET active = false, qr_token = NULL WHERE teacher_id = $1 AND active = true RETURNING id', [teacherId]);
            if (r.rows.length) broadcastTo(teacherId, { type: 'closed' });
            return send(res, 200, { ok: true });
        }

        // --- delete session (and its attendance) ---
        if (req.method === 'POST' && pathname === '/api/delete-session') {
            const { teacherId, sessionId } = await readBody(req);
            const sessionR = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
            const session = sessionR.rows[0];
            if (!session) return send(res, 404, { error: 'not found' });
            if (session.teacher_id !== teacherId) return send(res, 403, { error: 'not your session' });

            await pool.query('DELETE FROM attendance WHERE session_id = $1', [sessionId]);
            await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
            return send(res, 200, { ok: true });
        }

        // --- SSE stream ---
        if (req.method === 'GET' && pathname === '/api/stream') {
            const teacherId = searchParams.get('teacherId') || '';
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            const current = await getActiveSession(teacherId);
            const currentJson = await sessionToJson(current);
            res.write(`data: ${JSON.stringify({ type: 'init', session: currentJson })}\n\n`);
            clients.push({ res, teacherId });
            req.on('close', () => { clients = clients.filter(c => c.res !== res); });
            return;
        }

        // --- history ---
        if (req.method === 'GET' && pathname === '/api/history') {
            const teacherId = searchParams.get('teacherId') || '';
            const r = await pool.query(`
                SELECT s.id, s.subject, s.created_at, s.active, COUNT(a.id) AS count
                FROM sessions s
                LEFT JOIN attendance a ON a.session_id = s.id
                WHERE s.teacher_id = $1
                GROUP BY s.id
                ORDER BY s.id DESC
            `, [teacherId]);
            const list = r.rows.map(row => ({
                id: row.id, subject: row.subject, createdAt: row.created_at.toISOString(),
                count: Number(row.count), active: row.active
            }));
            return send(res, 200, list);
        }

        // --- single session ---
        if (req.method === 'GET' && pathname === '/api/session') {
            const id = Number(searchParams.get('id'));
            const r = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
            if (!r.rows[0]) return send(res, 404, { error: 'not found' });
            const session = await sessionToJson(r.rows[0]);
            return send(res, 200, session);
        }

        // --- export csv ---
        if (req.method === 'GET' && pathname === '/api/export') {
            const id = Number(searchParams.get('id'));
            const sessionR = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
            const session = sessionR.rows[0];
            if (!session) return send(res, 404, { error: 'not found' });
            const rowsR = await pool.query('SELECT * FROM attendance WHERE session_id = $1 ORDER BY time', [id]);
            res.writeHead(200, {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${safeFilename(session.teacher_name, session.subject, session.id)}"`
            });
            return res.end(toCsv(session.subject, rowsR.rows));
        }

        // --- super-admin ---
        if (req.method === 'POST' && pathname === '/api/admin/login') {
            const { username, password } = await readBody(req);
            return send(res, username === SUPERADMIN_USER && password === SUPERADMIN_PASS ? 200 : 401, { ok: true });
        }

        if (req.method === 'GET' && pathname === '/api/admin/teachers') {
            const r = await pool.query('SELECT id, name, username FROM teachers ORDER BY name');
            return send(res, 200, r.rows);
        }

        if (req.method === 'POST' && pathname === '/api/admin/teachers') {
            const { name, username, password } = await readBody(req);
            if (!name || !username || !password) return send(res, 400, { error: 'missing fields' });
            const existing = await pool.query('SELECT 1 FROM teachers WHERE username = $1', [username]);
            if (existing.rows.length) return send(res, 409, { error: 'username taken' });
            const id = nodeCrypto.randomUUID();
            await pool.query('INSERT INTO teachers (id, name, username, password) VALUES ($1, $2, $3, $4)', [id, name, username, password]);
            return send(res, 200, { ok: true, id });
        }

        if (req.method === 'POST' && pathname === '/api/admin/teachers/delete') {
            const { id } = await readBody(req);
            await pool.query('DELETE FROM teachers WHERE id = $1', [id]);
            return send(res, 200, { ok: true });
        }

        send(res, 404, { error: 'not found' });
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'server error' });
    }
});

function startServer(port) {
    currentPort = port;
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            const nextPort = port + 1;
            if (nextPort <= DEFAULT_PORT + MAX_PORT_ATTEMPTS) {
                console.log(`Port ${port} is busy. Trying ${nextPort} instead...`);
                startServer(nextPort);
                return;
            }
            throw error;
        }
        throw error;
    });
    server.listen(port, () => console.log(`http://localhost:${port}`));
}

initDb()
    .then(() => startServer(DEFAULT_PORT))
    .catch(err => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });