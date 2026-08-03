// plain Node, zero deps: http + fs + crypto only. Run: npx ts-node server.ts
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

type Teacher = { id: string; name: string; username: string; password: string };
type Student = { name: string; enrollment: string; section: string };
type PresentStudent = Student & { time: string };

type SessionRecord = {
    id: number;
    teacherId: string;
    teacherName: string;
    subject: string | null;

    qrToken: string | null;

    present: Record<string, PresentStudent>;
    createdAt: string;
    active: boolean;
};

type DB = {
    teachers: Record<string, Teacher>;
    students: Record<string, Student>;
    sessions: SessionRecord[];
    nextSessionId: number;
};

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_ATTEMPTS = 10;
let currentPort = DEFAULT_PORT;
const DB_FILE = path.join(__dirname, 'data.json');
const SUPERADMIN_USER = 'admin'; // ponytail: plaintext creds, hash+env if this leaves your LAN
const SUPERADMIN_PASS = 'changeme';

function loadDB(): DB {
    if (!fs.existsSync(DB_FILE)) {
        return { teachers: {}, students: {}, sessions: [], nextSessionId: 1 };
    }
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Record<string, any>;
    if (!raw.teachers) raw.teachers = {};
    if (!raw.sessions) raw.sessions = [];
    if (!raw.nextSessionId) raw.nextSessionId = (raw.sessions.length ? Math.max(...raw.sessions.map((s: any) => s.id)) + 1 : 1);
    return raw as DB;
}

let db: DB = loadDB();

function save(): void {
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

let clients: { res: import("http").ServerResponse; teacherId: string }[] = [];
function broadcastTo(teacherId: string, data: unknown): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clients.filter(c => c.teacherId === teacherId).forEach(c => c.res.write(msg));
}
function send(res: import("http").ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
function readBody(req: import("http").IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) { reject(e); }
        });
    });
}
function activeSessionFor(teacherId: string): SessionRecord | undefined {
    return db.sessions.find(s => s.teacherId === teacherId && s.active);
}
function csvEscape(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(session: SessionRecord): string {
    const rows = Object.values(session.present);
    const header = 'Name,Enrollment,Section,Subject,Time\n';
    return header + rows.map(r =>
        [r.name, r.enrollment, r.section, session.subject || '', r.time].map(csvEscape).join(',')
    ).join('\n');
}
function safeFilename(session: SessionRecord): string {
    const base = `${session.teacherName}-${session.subject || 'no-subject'}-session-${session.id}`;
    return base.replace(/[^a-zA-Z0-9 \-_.]/g, '').trim().replace(/\s+/g, '-') + '.csv';
}

const server = http.createServer(async (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
    const host = (req.headers && req.headers.host) ? req.headers.host : `localhost:${currentPort}`;
    const { pathname, searchParams } = new URL(req.url ?? '/', `http://${host}`);

    // --- static pages ---
    if (req.method === 'GET' && ['/', '/student.html', '/admin.html', '/superadmin.html'].includes(pathname)) {
        const file = pathname === '/' ? 'student.html' : pathname.slice(1);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    }

    // --- student profile + attendance ---
    if (req.method === 'POST' && pathname === '/api/register') {
        const { name, enrollment, section } = await readBody(req);
        if (!name || !enrollment || !section) return send(res, 400, { error: 'missing fields' });
        db.students[enrollment] = { name, enrollment, section };
        save();
        return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/mark') {
        const { enrollment, token } = await readBody(req);
        const student = db.students[enrollment];
        if (!student) return send(res, 404, { error: 'register first' });
        if (!token) return send(res, 400, { error: 'missing QR token — scan the code again' });
        const session = db.sessions.find(s => s.active && s.qrToken === token);
        if (!session) return send(res, 401, { error: 'QR code is invalid or expired' });
        if (session.present[enrollment]) return send(res, 200, { ok: true, already: true });
        session.present[enrollment] = { ...student, time: new Date().toISOString() };
        save();
        broadcastTo(session.teacherId, { type: 'mark', student: session.present[enrollment] });
        return send(res, 200, { ok: true });
    }

    // --- teacher auth ---
    if (req.method === 'POST' && pathname === '/api/login') {
        const { username, password } = await readBody(req);
        const teacher = Object.values(db.teachers).find(t => t.username === username && t.password === password);
        if (!teacher) return send(res, 401, { error: 'invalid credentials' });
        return send(res, 200, { ok: true, teacherId: teacher.id, teacherName: teacher.name });
    }

    // --- teacher session flow ---
    // --- Start QR attendance session ---
if (req.method === 'POST' && pathname === '/api/start-session') {

    const { teacherId, subject } = await readBody(req) as {
        teacherId?: string;
        subject?: string;
    };

    const teacher = teacherId ? db.teachers[teacherId] : null;

    if (!teacher) {
        return send(res, 401, { error: 'not logged in' });
    }

    // Close previous active session
    const prev = activeSessionFor(teacher.id);

    if (prev) {
        prev.active = false;
        prev.qrToken = null;
    }

    // Generate secure random token for QR code
    const qrToken = nodeCrypto.randomBytes(32).toString('hex');

    const session: SessionRecord = {
        id: db.nextSessionId++,
        teacherId: teacher.id,
        teacherName: teacher.name,
        subject: subject && subject.trim() ? subject.trim() : null,

        // OTP replaced with QR token
        qrToken: qrToken,

        present: {},
        createdAt: new Date().toISOString(),
        active: true
    };

    db.sessions.push(session);

    save();

    // Update teacher dashboard
    broadcastTo(teacher.id, {
        type: 'new-session',
        session
    });

    // Send token to admin.html for QR generation
    return send(res, 200, {
        qrToken: session.qrToken,
        sessionId: session.id
    });
}

    if (req.method === 'POST' && pathname === '/api/close-session') {
        const { teacherId } = await readBody(req);
        const session = activeSessionFor(teacherId);
        if (session) { session.active = false; session.qrToken = null; save(); broadcastTo(teacherId, { type: 'closed' }); }
        return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
        const teacherId = searchParams.get('teacherId') || '';
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const current = activeSessionFor(teacherId);
        res.write(`data: ${JSON.stringify({ type: 'init', session: current || null })}\n\n`);
        clients.push({ res, teacherId });
        req.on('close', () => { clients = clients.filter(c => c.res !== res); });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/history') {
        const teacherId = searchParams.get('teacherId') || '';
        const list = db.sessions
            .filter(s => s.teacherId === teacherId)
            .sort((a, b) => b.id - a.id)
            .map(s => ({ id: s.id, subject: s.subject, createdAt: s.createdAt, count: Object.keys(s.present).length, active: s.active }));
        return send(res, 200, list);
    }

    if (req.method === 'GET' && pathname === '/api/session') {
        const id = Number(searchParams.get('id'));
        const session = db.sessions.find(s => s.id === id);
        if (!session) return send(res, 404, { error: 'not found' });
        return send(res, 200, session);
    }

    if (req.method === 'GET' && pathname === '/api/export') {
        const id = Number(searchParams.get('id'));
        const session = db.sessions.find(s => s.id === id);
        if (!session) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${safeFilename(session)}"` });
        return res.end(toCsv(session));
    }

    // --- super-admin: manage teacher accounts ---
    if (req.method === 'POST' && pathname === '/api/admin/login') {
        const { username, password } = await readBody(req);
        return send(res, username === SUPERADMIN_USER && password === SUPERADMIN_PASS ? 200 : 401, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/admin/teachers') {
        const list = Object.values(db.teachers).map(({ password, ...rest }) => rest);
        return send(res, 200, list);
    }

    if (req.method === 'POST' && pathname === '/api/admin/teachers') {
        const { name, username, password } = await readBody(req);
        if (!name || !username || !password) return send(res, 400, { error: 'missing fields' });
        if (Object.values(db.teachers).some(t => t.username === username)) return send(res, 409, { error: 'username taken' });
        const id = nodeCrypto.randomUUID();
        db.teachers[id] = { id, name, username, password };
        save();
        return send(res, 200, { ok: true, id });
    }

    if (req.method === 'POST' && pathname === '/api/admin/teachers/delete') {
        const { id } = await readBody(req);
        delete db.teachers[id];
        save();
        return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
});

function startServer(port: number): void {
    currentPort = port;
    server.on('error', (error: NodeJS.ErrnoException) => {
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

startServer(DEFAULT_PORT);