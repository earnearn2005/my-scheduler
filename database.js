const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('./users.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    const sql = "SELECT * FROM users WHERE username = ?";
    db.get(sql, ["admin"], (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync("1234", 10);
            const insert = "INSERT INTO users (username, password) VALUES (?, ?)";
            db.run(insert, ["admin", hash]);
            console.log("✅ Admin user created (User: admin, Pass: 1234)");
        }
    });
});

module.exports = db;