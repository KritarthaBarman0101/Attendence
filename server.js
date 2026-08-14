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
            section TEXT NOT NULL
        );
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

// --- Enrollment sorting helpers ---
function getEnrollmentNumber(enrollment) {
    if (!enrollment) return Infinity;
    const parts = enrollment.split('/');
    const num = Number(parts[parts.length - 1]);
    return isNaN(num) ? Infinity : num;
}

function sortStudentsByEnrollment(students) {
    return [...students].sort((a, b) =>
        getEnrollmentNumber(a.enrollment) - getEnrollmentNumber(b.enrollment)
    );
}

// --- Validation helpers (shared with registration + edit) ---
const NAME_REGEX = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;
const ENROLLMENT_REGEX = /^ADTU\/\d+\/\d{4}-\d{2,4}\/[A-Z0-9]+\/\d+$/;
const SECTION_REGEX = /^[A-Z]$/;

function validateStudentFields(name, enrollment, section) {
    const n = (name || '').trim();
    const e = (enrollment || '').trim().toUpperCase();
    const s = (section || '').trim().toUpperCase();
    if (!n) return { error: 'Name is required' };
    if (n.length > 100) return { error: 'Name must not exceed 100 characters' };
    if (!NAME_REGEX.test(n)) return { error: 'Name must contain letters and spaces only' };
    if (!e) return { error: 'Enrollment ID is required' };
    if (!ENROLLMENT_REGEX.test(e)) return { error: 'Invalid enrollment ID format. Expected format: ADTU/1/2023-26/BCAO/012' };
    if (!s) return { error: 'Section is required' };
    if (!SECTION_REGEX.test(s)) return { error: 'Section must be a single letter (e.g. A, B, C)' };
    return { name: n, enrollment: e, section: s };
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
    const students = r.rows.map(row => ({
        name: row.name, enrollment: row.enrollment, section: row.section, time: row.time.toISOString()
    }));
    const sorted = sortStudentsByEnrollment(students);
    const present = {};
    for (const s of sorted) {
        present[s.enrollment] = s;
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
            const body = await readBody(req);
            const v = validateStudentFields(body.name, body.enrollment, body.section);
            if (v.error) return send(res, 400, { error: v.error });

            const existing = await pool.query('SELECT 1 FROM students WHERE enrollment = $1', [v.enrollment]);
            if (existing.rows.length) return send(res, 409, { error: 'Student with this enrollment ID is already registered' });

            await pool.query('INSERT INTO students (enrollment, name, section) VALUES ($1, $2, $3)', [v.enrollment, v.name, v.section]);
            return send(res, 200, { ok: true });
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

        // --- a student's attendance overview: per-subject breakdown + overall percentage ---
        if (req.method === 'GET' && pathname === '/api/my-attendance') {
            const enrollment = (searchParams.get('enrollment') || '').trim().toUpperCase();
            if (!enrollment) return send(res, 400, { error: 'enrollment is required' });

            const studentR = await pool.query('SELECT 1 FROM students WHERE enrollment = $1', [enrollment]);
            if (!studentR.rows.length) return send(res, 404, { error: 'No profile found for this enrollment ID' });

            // One row per (teacher, subject) "course" the student has attended at least once,
            // with how many sessions that course has run in total vs how many the student attended.
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

            const recentR = await pool.query(`
                SELECT a.time, s.subject, s.teacher_name
                FROM attendance a
                JOIN sessions s ON s.id = a.session_id
                WHERE a.enrollment = $1
                ORDER BY a.time DESC
                LIMIT 20
            `, [enrollment]);

            return send(res, 200, {
                bySubject: bySubjectR.rows.map(r => ({
                    subject: r.subject,
                    teacherName: r.teacher_name,
                    totalSessions: Number(r.total_sessions),
                    presentSessions: Number(r.present_sessions)
                })),
                recent: recentR.rows.map(r => ({
                    time: r.time.toISOString(), subject: r.subject, teacherName: r.teacher_name
                }))
            });
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
            const rowsR = await pool.query('SELECT * FROM attendance WHERE session_id = $1', [id]);
            const sortedRows = sortStudentsByEnrollment(rowsR.rows);
            res.writeHead(200, {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${safeFilename(session.teacher_name, session.subject, session.id)}"`
            });
            return res.end(toCsv(session.subject, sortedRows));
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

        // --- edit student attendance ---
        if (req.method === 'POST' && /^\/api\/session\/\d+\/student\/edit$/.test(pathname)) {
            const sessionId = Number(pathname.split('/')[3]);
            const { teacherId: reqTeacherId, oldEnrollment, name, enrollment, section } = await readBody(req);

            // Auth checks
            const teacher = await getTeacherById(reqTeacherId);
            if (!teacher) return send(res, 401, { error: 'Not authenticated' });
            const sessionR = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
            const session = sessionR.rows[0];
            if (!session) return send(res, 404, { error: 'Session not found' });
            if (session.teacher_id !== teacher.id) return send(res, 403, { error: 'Not authorized to modify this session' });

            // Validate input
            const v = validateStudentFields(name, enrollment, section);
            if (v.error) return send(res, 400, { error: v.error });
            const normalizedOld = (oldEnrollment || '').trim().toUpperCase();
            if (!normalizedOld) return send(res, 400, { error: 'Old enrollment ID is required' });

            // Check attendance record exists
            const attR = await pool.query('SELECT * FROM attendance WHERE session_id = $1 AND enrollment = $2', [sessionId, normalizedOld]);
            if (!attR.rows.length) return send(res, 404, { error: 'Attendance record not found in this session' });
            const originalTime = attR.rows[0].time;

            // If enrollment is changing, check for conflict
            const enrollmentChanged = normalizedOld !== v.enrollment;
            if (enrollmentChanged) {
                const conflict = await pool.query('SELECT 1 FROM students WHERE enrollment = $1', [v.enrollment]);
                if (conflict.rows.length) return send(res, 409, { error: 'This enrollment ID is already registered' });
            }

            // Perform atomic updates using a transaction
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Update student profile
                await client.query('UPDATE students SET enrollment = $1, name = $2, section = $3 WHERE enrollment = $4',
                    [v.enrollment, v.name, v.section, normalizedOld]);

                // Update attendance record (preserve original time)
                if (enrollmentChanged) {
                    // Delete old, insert new to satisfy UNIQUE constraint
                    await client.query('DELETE FROM attendance WHERE session_id = $1 AND enrollment = $2', [sessionId, normalizedOld]);
                    await client.query('INSERT INTO attendance (session_id, enrollment, name, section, time) VALUES ($1, $2, $3, $4, $5)',
                        [sessionId, v.enrollment, v.name, v.section, originalTime]);
                } else {
                    await client.query('UPDATE attendance SET name = $1, section = $2 WHERE session_id = $3 AND enrollment = $4',
                        [v.name, v.section, sessionId, v.enrollment]);
                }

                // Also update any other attendance records for this student in other sessions
                if (enrollmentChanged) {
                    await client.query('UPDATE attendance SET enrollment = $1, name = $2, section = $3 WHERE enrollment = $4',
                        [v.enrollment, v.name, v.section, normalizedOld]);
                } else {
                    await client.query('UPDATE attendance SET name = $1, section = $2 WHERE enrollment = $3',
                        [v.name, v.section, v.enrollment]);
                }

                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }

            broadcastTo(teacher.id, {
                type: 'student-updated',
                oldEnrollment: normalizedOld,
                student: { name: v.name, enrollment: v.enrollment, section: v.section, time: originalTime.toISOString() }
            });
            return send(res, 200, { ok: true });
        }

        // --- delete student attendance ---
        if (req.method === 'POST' && /^\/api\/session\/\d+\/student\/delete$/.test(pathname)) {
            const sessionId = Number(pathname.split('/')[3]);
            const { teacherId: reqTeacherId, enrollment } = await readBody(req);

            // Auth checks
            const teacher = await getTeacherById(reqTeacherId);
            if (!teacher) return send(res, 401, { error: 'Not authenticated' });
            const sessionR = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
            const session = sessionR.rows[0];
            if (!session) return send(res, 404, { error: 'Session not found' });
            if (session.teacher_id !== teacher.id) return send(res, 403, { error: 'Not authorized to modify this session' });

            const normalizedEnrollment = (enrollment || '').trim().toUpperCase();
            if (!normalizedEnrollment) return send(res, 400, { error: 'Enrollment ID is required' });

            // Check attendance exists
            const attR = await pool.query('SELECT 1 FROM attendance WHERE session_id = $1 AND enrollment = $2', [sessionId, normalizedEnrollment]);
            if (!attR.rows.length) return send(res, 404, { error: 'Attendance record not found in this session' });

            // Remove attendance only (NOT the student profile)
            await pool.query('DELETE FROM attendance WHERE session_id = $1 AND enrollment = $2', [sessionId, normalizedEnrollment]);

            broadcastTo(teacher.id, {
                type: 'student-deleted',
                enrollment: normalizedEnrollment
            });
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