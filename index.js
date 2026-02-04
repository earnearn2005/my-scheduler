const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const db = require('./database');

const app = express();
const PORT = 80;

// Config
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'secret-key-scheduler',
    resave: false,
    saveUninitialized: true
}));

// Data Store
const dataStore = {
    teachers: [], rooms: [], studentGroups: [],
    teaches: [], timeslots: [], registers: [], subjects: []
};

//Test CI/CD
// CSV Loader
const loadCSV = (fileName) => {
    return new Promise((resolve, reject) => {
        const results = [];
        const filePath = path.join(__dirname, 'data', fileName);
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders: ({ header }) => header.trim().replace(/^\ufeff/, '') }))
            .on('data', (row) => {
                if (row.student_count) row.student_count = parseFloat(row.student_count);
                if (row.theory) row.theory = parseInt(row.theory);
                if (row.practice) row.practice = parseInt(row.practice);
                if (row.credit) row.credit = parseInt(row.credit);
                if (row.timeslot_id) row.timeslot_id = parseInt(row.timeslot_id);
                if (row.period) row.period = parseInt(row.period);
                results.push(row);
            })
            .on('end', () => resolve({ fileName, data: results }))
            .on('error', (err) => reject(err));
    });
};

const initData = async () => {
    try {
        const files = ['teacher.csv', 'room.csv', 'student_group.csv', 'teach.csv', 'timeslot.csv', 'register.csv', 'subject.csv'];
        console.log("⏳ Loading CSV files...");
        const loadedFiles = await Promise.all(files.map(f => loadCSV(f)));
        loadedFiles.forEach(({ fileName, data }) => {
            if (fileName === 'teacher.csv') dataStore.teachers = data;
            else if (fileName === 'room.csv') dataStore.rooms = data;
            else if (fileName === 'student_group.csv') dataStore.studentGroups = data;
            else if (fileName === 'teach.csv') dataStore.teaches = data;
            else if (fileName === 'timeslot.csv') dataStore.timeslots = data;
            else if (fileName === 'register.csv') dataStore.registers = data;
            else if (fileName === 'subject.csv') dataStore.subjects = data;
        });
        dataStore.timeslots.sort((a, b) => a.timeslot_id - b.timeslot_id);
        console.log(`✅ All CSV Data Loaded Successfully!`);
    } catch (error) { console.error("❌ Error loading CSV:", error); }
};
initData();

// Routes
const requireLogin = (req, res, next) => {
    if (req.session.loggedin) next(); else res.redirect('/login');
};

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
        if (row && bcrypt.compareSync(password, row.password)) {
            req.session.loggedin = true;
            req.session.username = username;
            res.redirect('/');
        } else { res.render('login', { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }); }
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/', requireLogin, (req, res) => {
    res.render('dashboard', {
        counts: { subjects: dataStore.subjects.length, teachers: dataStore.teachers.length, rooms: dataStore.rooms.length, groups: dataStore.studentGroups.length },
        dropdownData: { groups: dataStore.studentGroups, teachers: dataStore.teachers, rooms: dataStore.rooms }
    });
});

// Scheduling Algorithm Helper
const isSlotAvailable = (schedule, timeslotId, teacherId, roomId, groupId) => {
    return !schedule.some(s => s.timeslot_id === timeslotId && (s.teacher_id === teacherId || s.room_id === roomId || s.group_id === groupId));
};

const processSchedulingRound = (tasks, existingSchedule, allowedPeriods) => {
    const scheduledInThisRound = [];
    const remainingTasks = [];
    const activeTimeslots = dataStore.timeslots.filter(t => allowedPeriods.includes(t.period));

    tasks.forEach(task => {
        let assigned = false;
        const possibleTeachers = dataStore.teaches.filter(t => t.subject_id === task.subject_id).map(t => dataStore.teachers.find(teacher => teacher.teacher_id === t.teacher_id)).filter(t => t);
        const teacher = possibleTeachers[0];

        if (teacher) {
            const validRooms = dataStore.rooms.filter(r => {
                if (task.type === 'Theory') return r.room_type === 'Theory' || r.room_type === 'Classroom';
                return r.room_type.includes('Lab') || r.room_type === 'Practice' || r.room_type.includes('Computer');
            });
            const possibleRooms = validRooms.length > 0 ? validRooms : dataStore.rooms;

            for (const room of possibleRooms) {
                if (assigned) break;
                for (let i = 0; i < activeTimeslots.length; i++) {
                    if (i + task.hours > activeTimeslots.length) continue;
                    let canBook = true;
                    const slotsToBook = [];
                    for (let h = 0; h < task.hours; h++) {
                        const slot = activeTimeslots[i + h];
                        if (h > 0 && slot.day !== activeTimeslots[i + h - 1].day) { canBook = false; break; }
                        if (h > 0 && slot.period !== activeTimeslots[i + h - 1].period + 1) { canBook = false; break; }
                        const collision = isSlotAvailable(existingSchedule.concat(scheduledInThisRound), slot.timeslot_id, teacher.teacher_id, room.room_id, task.group_id);
                        if (!collision) { canBook = false; break; }
                        slotsToBook.push(slot);
                    }
                    if (canBook) {
                        slotsToBook.forEach(slot => {
                            scheduledInThisRound.push({
                                group_id: task.group_id,
                                group_name: dataStore.studentGroups.find(g => g.group_id === task.group_id)?.group_name || task.group_id,
                                advisor: dataStore.studentGroups.find(g => g.group_id === task.group_id)?.advisor || '-',
                                subject_id: task.subject_id,
                                subject_name: task.subject.subject_name,
                                subject_type: task.type,
                                theory: task.subject.theory,
                                practice: task.subject.practice,
                                credit: task.subject.credit,
                                teacher_id: teacher.teacher_id,
                                teacher: teacher.teacher_name,
                                room_id: room.room_id,
                                room: room.room_name,
                                timeslot_id: slot.timeslot_id,
                                day: slot.day,
                                time: `${slot.start} - ${slot.end}`,
                                period: slot.period
                            });
                        });
                        assigned = true;
                        break;
                    }
                }
            }
        }
        if (!assigned) remainingTasks.push(task);
    });
    return { newSchedule: scheduledInThisRound, leftovers: remainingTasks };
};

// API Endpoint
app.get('/api/generate-schedule', (req, res) => {
    console.log("🚀 Starting 2-PASS STRICT Algorithm...");
    let finalSchedule = [];
    let allTasks = [];
    dataStore.registers.forEach(reg => {
        const subject = dataStore.subjects.find(s => s.subject_id === reg.subject_id);
        if (subject) {
            if (subject.theory > 0) allTasks.push({ ...reg, type: 'Theory', hours: subject.theory, subject });
            if (subject.practice > 0) allTasks.push({ ...reg, type: 'Practice', hours: subject.practice, subject });
        }
    });
    allTasks.sort((a, b) => b.hours - a.hours);

    // Round 1: Period 1-8
    const round1 = processSchedulingRound(allTasks, finalSchedule, [1, 2, 3, 4, 6, 7, 8]);
    finalSchedule = finalSchedule.concat(round1.newSchedule);

    // Round 2: Period 9-12 (Leftovers only)
    if (round1.leftovers.length > 0) {
        const round2 = processSchedulingRound(round1.leftovers, finalSchedule, [9, 10, 11, 12]);
        finalSchedule = finalSchedule.concat(round2.newSchedule);
    }

    finalSchedule.sort((a, b) => a.timeslot_id - b.timeslot_id);
    res.json(finalSchedule);
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));